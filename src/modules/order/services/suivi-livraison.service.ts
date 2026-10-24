import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { CourseOfferStatus, CourseStatut, EntityStatus, Prisma } from '@prisma/client';

import { parIdentifiantOuReference } from 'src/common/utils/identifiant.util';
import { PrismaService } from 'src/database/services/prisma.service';
import {
  CLES_REGLAGES_PLANIFICATION,
  lireReglagesPlanification,
  REGLAGES_PLANIFICATION_DEFAUT,
} from 'src/modules/course/helpers/planification.rules';
import { STATUTS_COURSE_EN_COURS } from 'src/modules/deliverers/helpers/disponibilite.rules';
import { SettingsService } from 'src/modules/settings/settings.service';
import { AppGateway } from 'src/socket-io/gateways/app.gateway';

import { PANIER_ANNULE_PAR_CLIENT_WHERE } from '../helpers/brouillons.rules';
import { CommandeLivraisonLue, SuiviLivraison, suiviLivraison } from '../helpers/suivi-livraison.rules';
import {
  CLE_APPLI_FERMEE_APRES_S,
  CLE_FACTEUR_RETARD,
  lireAppliFermeeApresS,
  lireFacteurRetard,
} from '../helpers/suivi-operations.rules';

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
      // Échec de CETTE livraison : motif et note du livreur.
      failure_reason: true,
      failure_note: true,
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
          // Retard de la tournée (règle commune, alerte du cron déjà donnée).
          delay_alerted_at: true,
          retenue_jusqua: true,
          deliverer: {
            select: {
              id: true, first_name: true, last_name: true, phone: true, last_location: true, last_location_at: true,
              // Appli du livreur : signe de vie et protocole, jamais renvoyés tels quels.
              dernier_signal_at: true, protocole_appli: true,
            },
          },
          // Offre en attente : « Proposée à Koffi ».
          offer_attempts: {
            where: { status: CourseOfferStatus.PENDING },
            orderBy: { offered_at: 'desc' },
            take: 1,
            select: { expires_at: true, deliverer: { select: { id: true, first_name: true, last_name: true } } },
          },
          // Arrêt 2 sur 3, sac encore attendu au comptoir, tournée : référence et
          // état de chaque commande, rien d'autre des autres clients.
          deliveries: {
            orderBy: { sequence_order: 'asc' },
            select: {
              id: true,
              statut: true,
              sequence_order: true,
              in_route_at: true,
              arrived_at: true,
              delivered_at: true,
              failed_at: true,
              order: { select: { reference: true, status: true } },
            },
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
 * au retrait). Les réglages ne sont relus que pour une course en cours
 * (acceptée, au restaurant, en livraison), en une lecture : fenêtre d'ajout
 * (course récupérée et pas encore partie), facteur de retard, seuil de
 * l'appli fermée. La présence de l'appli (socket ouvert) n'est demandée que
 * pour un livreur Chicken Nation sur une course en cours.
 */
@Injectable()
export class SuiviLivraisonService {
  private readonly logger = new Logger(SuiviLivraisonService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    @Optional() private readonly gateway?: AppGateway,
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
    // Course terminée ou sans livreur : ni retard ni appli à juger, rien à relire.
    if (!course || !STATUTS_COURSE_EN_COURS.includes(course.statut)) {
      return suiviLivraison(commande as CommandeLivraisonLue, { maintenant });
    }

    const fenetre = course.statut === CourseStatut.IN_DELIVERY && !!course.picked_up_at && !course.parti_at;
    let fenetreMaxS: number | undefined = fenetre ? REGLAGES_PLANIFICATION_DEFAUT.ajoutApresRetraitMaxS : undefined;
    let departRayonM: number | undefined = fenetre ? REGLAGES_PLANIFICATION_DEFAUT.departRayonM : undefined;
    let facteurRetard = lireFacteurRetard(undefined);
    let appliFermeeApresS = lireAppliFermeeApresS(undefined);
    try {
      const valeurs = await this.settings.getMany([
        ...CLES_REGLAGES_PLANIFICATION,
        CLE_FACTEUR_RETARD,
        CLE_APPLI_FERMEE_APRES_S,
      ]);
      if (fenetre) {
        const { reglages } = lireReglagesPlanification(valeurs);
        fenetreMaxS = reglages.ajoutApresRetrait ? reglages.ajoutApresRetraitMaxS : 0;
        departRayonM = reglages.departRayonM;
      }
      facteurRetard = lireFacteurRetard(valeurs[CLE_FACTEUR_RETARD]);
      appliFermeeApresS = lireAppliFermeeApresS(valeurs[CLE_APPLI_FERMEE_APRES_S]);
    } catch (err) {
      this.logger.warn(`Réglages du suivi de la livraison illisibles : ${(err as Error)?.message ?? err}`);
    }
    const connectes = course.deliverer ? await this.presence(course.deliverer.id) : null;
    return suiviLivraison(commande as CommandeLivraisonLue, {
      maintenant,
      fenetreMaxS,
      departRayonM,
      facteurRetard,
      appli: { appliFermeeApresS, connectes },
    });
  }

  /** Socket ouvert de l'appli du livreur ; `null` si la présence n'a pas pu être lue. */
  private async presence(delivererId: string): Promise<Set<string> | null> {
    if (!this.gateway) return null;
    try {
      return await this.gateway.livreursConnectes([delivererId]);
    } catch {
      return null;
    }
  }
}
