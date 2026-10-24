import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CourseOfferStatus, CourseStatut, EntityStatus, Prisma } from '@prisma/client';

import { parIdentifiantOuReference } from 'src/common/utils/identifiant.util';
import { PrismaService } from 'src/database/services/prisma.service';
import {
  CLES_REGLAGES_PLANIFICATION,
  lireReglagesPlanification,
  REGLAGES_PLANIFICATION_DEFAUT,
} from 'src/modules/course/helpers/planification.rules';
import { SettingsService } from 'src/modules/settings/settings.service';

import { PANIER_ANNULE_PAR_CLIENT_WHERE } from '../helpers/brouillons.rules';
import { CommandeLivraisonLue, SuiviLivraison, suiviLivraison } from '../helpers/suivi-livraison.rules';

/**
 * Ce que la section « Livraison » lit d'une commande, en une requête. Liste
 * blanche : ni la clé Turbo du restaurant, ni le code client de la livraison.
 */
const SELECT_SUIVI_LIVRAISON = {
  id: true,
  restaurant_id: true,
  type: true,
  status: true,
  delivery_service: true,
  ready_at: true,
  picked_up_at: true,
  collected_at: true,
  // Coordonnées : fenêtre d'ajout prolongée tant que la course attend son sac.
  restaurant: { select: { latitude: true, longitude: true } },
  delivery: {
    select: {
      id: true,
      statut: true,
      arrived_at: true,
      delivered_at: true,
      turbo_courier_id: true,
      turbo_courier_name: true,
      turbo_courier_phone: true,
      course: {
        select: {
          id: true,
          reference: true,
          pickup_code: true,
          statut: true,
          assigned_at: true,
          at_restaurant_at: true,
          picked_up_at: true,
          parti_at: true,
          motif_depart: true,
          estimated_duration_min: true,
          retenue_jusqua: true,
          deliverer: {
            select: { id: true, first_name: true, last_name: true, phone: true, last_location: true, last_location_at: true },
          },
          // Offre en attente : « Proposée à Koffi ».
          offer_attempts: {
            where: { status: CourseOfferStatus.PENDING },
            orderBy: { offered_at: 'desc' },
            take: 1,
            select: { expires_at: true, deliverer: { select: { id: true, first_name: true, last_name: true } } },
          },
          // Arrêt 2 sur 3, sac encore attendu au comptoir.
          deliveries: {
            orderBy: { sequence_order: 'asc' },
            select: { id: true, statut: true, sequence_order: true, order: { select: { status: true } } },
          },
        },
      },
    },
  },
} satisfies Prisma.OrderSelect;

export type CommandeSuiviLivraison = Prisma.OrderGetPayload<{ select: typeof SELECT_SUIVI_LIVRAISON }>;

/**
 * Section « Livraison » du tiroir de détail d'une commande
 * (`GET /orders/:id/livraison`) : la commande est lue ici, le suivi calculé
 * par la règle pure `suivi-livraison.rules.ts`.
 *
 * Aucun appel externe : les heures prévues sont celles que le serveur a déjà
 * (retenue, fenêtre d'ajout de l'écran Opérations, durée de la tournée figée
 * au retrait). Les réglages du planificateur ne sont relus que pour une
 * course récupérée et pas encore partie, seul cas où la fenêtre compte.
 */
@Injectable()
export class SuiviLivraisonService {
  private readonly logger = new Logger(SuiviLivraisonService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * La commande, par identifiant ou référence, comme le détail : supprimée,
   * elle est introuvable, sauf le panier annulé par le client pour les rôles
   * qui le suivent (`inclurePanierAnnuleParClient`).
   */
  async lire(id: string, options: { inclurePanierAnnuleParClient?: boolean } = {}): Promise<CommandeSuiviLivraison> {
    const parId = parIdentifiantOuReference(id);
    const commande = await this.prisma.order.findFirst({
      where: options.inclurePanierAnnuleParClient
        ? { AND: [parId, { OR: [{ entity_status: { not: EntityStatus.DELETED } }, PANIER_ANNULE_PAR_CLIENT_WHERE] }] }
        : { ...parId, entity_status: { not: EntityStatus.DELETED } },
      select: SELECT_SUIVI_LIVRAISON,
    });
    if (!commande) throw new NotFoundException('Commande introuvable');
    return commande;
  }

  async suivi(commande: CommandeSuiviLivraison, maintenant = new Date()): Promise<SuiviLivraison> {
    const course = commande.delivery?.course;
    let fenetreMaxS: number | undefined;
    let departRayonM: number | undefined;
    if (course?.statut === CourseStatut.IN_DELIVERY && course.picked_up_at && !course.parti_at) {
      fenetreMaxS = REGLAGES_PLANIFICATION_DEFAUT.ajoutApresRetraitMaxS;
      departRayonM = REGLAGES_PLANIFICATION_DEFAUT.departRayonM;
      try {
        const { reglages } = lireReglagesPlanification(await this.settings.getMany([...CLES_REGLAGES_PLANIFICATION]));
        fenetreMaxS = reglages.ajoutApresRetrait ? reglages.ajoutApresRetraitMaxS : 0;
        departRayonM = reglages.departRayonM;
      } catch (err) {
        this.logger.warn(`Réglages du planificateur illisibles : ${(err as Error)?.message ?? err}`);
      }
    }
    return suiviLivraison(commande as CommandeLivraisonLue, { maintenant, fenetreMaxS, departRayonM });
  }
}
