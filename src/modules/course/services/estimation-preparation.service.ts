import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { EntityStatus, OrderStatus } from '@prisma/client';
import type { Cache } from 'cache-manager';

import { PrismaService } from 'src/database/services/prisma.service';

import {
  ecartEstimationMinutes,
  estimerFinPreparation,
  EstimationPreparation,
  REGLAGES_PREPARATION_DEFAUT,
  ReglagesPreparation,
  StatistiquePreparation,
  statistiquesParTranche,
  TrancheHoraire,
} from '../helpers/preparation.rules';
import { DispatchJournalService } from './dispatch-journal.service';

/** Statistique gardée deux heures : la tâche horaire la recalcule avant. */
const DUREE_STATISTIQUE_MS = 2 * 60 * 60 * 1000;
/** Mesures lues : 14 jours de préparations du restaurant. */
const FENETRE_MESURES_MS = 14 * 24 * 60 * 60 * 1000;
/** Garde-fou : au plus ce nombre de mesures par restaurant. */
const MESURES_MAX = 5000;

export type StatistiquesRestaurant = Record<TrancheHoraire, StatistiquePreparation | null>;

const cleStatistique = (restaurantId: string) => `preparation:stats:${restaurantId}`;

/** Ce que l'estimation lit d'une commande. */
export interface CommandeAEstimer {
  id: string;
  status: OrderStatus;
  prepared_at: Date | null;
  estimated_preparation_time?: Date | null;
}

/**
 * FIN DE PRÉPARATION ESTIMÉE des commandes en cuisine (conception 3.2), pour
 * la retenue au comptoir du planificateur v2.
 *
 *  1. durée donnée par la cuisine au passage « En préparation »
 *     (`meta.estimated_preparation_time`, enregistrée par le serveur dans
 *     `Order.estimated_preparation_time`) : prioritaire ;
 *  2. statistique du restaurant par tranche horaire sur 14 jours (médiane
 *     pour « prête vers », 8e décile pour décider), recalculée toutes les
 *     heures et gardée dans Redis ;
 *  3. défauts réglés (`preparation.duree_defaut_min`, `preparation.duree_p80_min`).
 *
 * La règle elle-même est pure (preparation.rules.ts). Ce service ne lève
 * jamais : Redis coupé, la statistique est recalculée depuis la base ; base
 * en erreur, les défauts s'appliquent.
 */
@Injectable()
export class EstimationPreparationService {
  private readonly logger = new Logger(EstimationPreparationService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CACHE_MANAGER) private readonly cache: Cache,
    private readonly journal: DispatchJournalService,
  ) {}

  /** Statistique du restaurant : Redis, sinon recalculée depuis la base (et gardée). */
  async statistiques(restaurantId: string, maintenant = new Date()): Promise<StatistiquesRestaurant | null> {
    try {
      const gardee = await this.cache.get<StatistiquesRestaurant>(cleStatistique(restaurantId));
      if (gardee) return gardee;
    } catch (err) {
      this.logger.warn(`Statistique de préparation illisible dans Redis : ${(err as Error)?.message}`);
    }
    return this.recalculer(restaurantId, maintenant);
  }

  /** Recalcule la statistique d'un restaurant sur 14 jours et la garde deux heures. */
  async recalculer(restaurantId: string, maintenant = new Date()): Promise<StatistiquesRestaurant | null> {
    let stats: StatistiquesRestaurant;
    try {
      const mesures = await this.prisma.order.findMany({
        where: {
          restaurant_id: restaurantId,
          entity_status: { not: EntityStatus.DELETED },
          prepared_at: { not: null, gte: new Date(maintenant.getTime() - FENETRE_MESURES_MS) },
          ready_at: { not: null },
        },
        select: { prepared_at: true, ready_at: true },
        orderBy: { prepared_at: 'desc' },
        take: MESURES_MAX,
      });
      stats = statistiquesParTranche(
        mesures
          .filter((m) => m.prepared_at && m.ready_at)
          .map((m) => ({ prepared_at: m.prepared_at as Date, ready_at: m.ready_at as Date })),
      );
    } catch (err) {
      this.logger.warn(`Statistique de préparation non calculée (${restaurantId.slice(0, 8)}) : ${(err as Error)?.message}`);
      return null;
    }
    try {
      await this.cache.set(cleStatistique(restaurantId), stats, DUREE_STATISTIQUE_MS);
    } catch (err) {
      this.logger.warn(`Statistique de préparation non gardée dans Redis : ${(err as Error)?.message}`);
    }
    return stats;
  }

  /** Tâche horaire : recalcule la statistique de chaque restaurant actif sur 14 jours. */
  async recalculerTout(maintenant = new Date()): Promise<number> {
    const lignes = await this.prisma.order.findMany({
      where: {
        prepared_at: { gte: new Date(maintenant.getTime() - FENETRE_MESURES_MS) },
        ready_at: { not: null },
      },
      select: { restaurant_id: true },
      distinct: ['restaurant_id'],
    });
    const restaurants = [...new Set(lignes.map((l) => l.restaurant_id))];
    for (const id of restaurants) await this.recalculer(id, maintenant);
    return restaurants.length;
  }

  /**
   * Fin estimée de chaque commande EN PRÉPARATION (les autres n'en ont pas).
   * Une seule lecture de la statistique pour le restaurant.
   */
  async estimer(
    restaurantId: string,
    commandes: readonly CommandeAEstimer[],
    maintenant: Date,
    reglages: ReglagesPreparation = REGLAGES_PREPARATION_DEFAUT,
  ): Promise<Map<string, EstimationPreparation>> {
    const resultat = new Map<string, EstimationPreparation>();
    const enCuisine = commandes.filter((c) => c.status === OrderStatus.IN_PROGRESS);
    if (enCuisine.length === 0) return resultat;
    const stats = await this.statistiques(restaurantId, maintenant);
    for (const c of enCuisine) {
      const estimation = estimerFinPreparation(c, stats, maintenant, reglages);
      if (estimation) resultat.set(c.id, estimation);
    }
    return resultat;
  }

  /**
   * Commande devenue prête : l'estimation qu'on en aurait faite au passage
   * « En préparation » est comparée à la réalité (journal `[Preparation]` et
   * ligne PREPARATION_MESUREE), pour mesurer l'erreur (conception 6.2).
   */
  async mesurer(
    commande: {
      id: string;
      reference: string;
      restaurant_id: string;
      prepared_at: Date | null;
      ready_at: Date | null;
      estimated_preparation_time?: Date | null;
    },
    reglages: ReglagesPreparation = REGLAGES_PREPARATION_DEFAUT,
  ): Promise<void> {
    if (!commande.prepared_at || !commande.ready_at) return;
    const stats = await this.statistiques(commande.restaurant_id, commande.ready_at);
    const estimation = estimerFinPreparation(
      { status: OrderStatus.IN_PROGRESS, prepared_at: commande.prepared_at, estimated_preparation_time: commande.estimated_preparation_time },
      stats,
      commande.prepared_at,
      reglages,
    );
    if (!estimation) return;
    const ecart = ecartEstimationMinutes(estimation.finMediane, commande.ready_at);
    await this.journal.ecrire({
      type: 'PREPARATION_MESUREE',
      motif: estimation.source,
      source: 'serveur',
      restaurant_id: commande.restaurant_id,
      order_id: commande.id,
      details: {
        commande: commande.reference,
        estimee: estimation.finMediane.toISOString(),
        decision: estimation.finDecision.toISOString(),
        reelle: commande.ready_at.toISOString(),
        ecart_min: ecart,
      },
    });
  }
}
