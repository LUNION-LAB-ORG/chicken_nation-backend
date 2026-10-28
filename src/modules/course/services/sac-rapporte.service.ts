import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { DeliveryStatut, EntityStatus, Order, OrderStatus, OrderType, Prisma } from '@prisma/client';

import { PrismaService } from 'src/database/services/prisma.service';
import { DelivererPushService } from 'src/modules/deliverers/services/deliverer-push.service';
import { CLIENT_COMMANDE_SELECT } from 'src/modules/order/constantes/client-commande.select';
import { OrderWebSocketService } from 'src/modules/order/websockets/order-websocket.service';
import { RESTAURANT_COMMANDE_SELECT } from 'src/modules/restaurant/constantes/restaurant-public.select';
import { ComptePersonnel } from 'src/modules/users/helpers/personnel-scope.helper';

import { CourseEvent } from '../events/course.event';
import { COURSE_FULL_INCLUDE } from '../helpers/course.includes';
import { recalculerFraisCourse } from '../helpers/frais-course';
import {
  assertCommandeDuRestaurant,
  copieLivraisonAnnulee,
  estSacARapporter,
  MESSAGE_COMMANDE_CHANGEE,
  MESSAGE_COMMANDE_INTROUVABLE,
  RAISON_SAC_RAPPORTE,
  refusSansSac,
  SACS_A_RAPPORTER_FENETRE_MS,
  sourceDuGeste,
} from '../helpers/sac-rapporte.rules';
import type { CourseWithDetails } from '../interfaces/course-event.interface';
import { CourseWebSocketService } from '../websockets/course-websocket.service';

/** Ce que le geste lit de la commande : sa livraison, sa course, son livreur. Jamais le code du client. */
const SELECTION_SAC = {
  id: true,
  reference: true,
  status: true,
  type: true,
  entity_status: true,
  restaurant_id: true,
  batch_id: true,
  delivery: {
    select: {
      id: true,
      statut: true,
      sequence_order: true,
      in_route_at: true,
      arrived_at: true,
      failed_at: true,
      failure_reason: true,
      failure_note: true,
      customer_rating: true,
      customer_rating_note: true,
      course: {
        select: {
          id: true,
          reference: true,
          turbo_escalated_at: true,
          deliverer: { select: { id: true, first_name: true, last_name: true } },
        },
      },
    },
  },
} satisfies Prisma.OrderSelect;

type CommandeSac = Prisma.OrderGetPayload<{ select: typeof SELECTION_SAC }>;

/** La commande telle que `OrderService.updateStatus` la diffuse (sans réglages de notification). */
const INCLUDE_STATUT = {
  order_items: { include: { dish: true } },
  paiements: true,
  customer: { select: CLIENT_COMMANDE_SELECT },
  restaurant: { select: RESTAURANT_COMMANDE_SELECT },
} satisfies Prisma.OrderInclude;

/** Réponse de `POST /courses/operations/commandes/:orderId/sac-rapporte`. */
export interface ReponseSacRapporte {
  order_id: string;
  reference: string;
  status: OrderStatus;
  livreur: { id: string; prenom: string | null } | null;
  /** `true` : geste déjà enregistré (double toucher, seconde caisse) ; rien n'est réécrit ni émis. */
  deja: boolean;
}

/** Un sac à rapporter, pour le rappel de l'appli du livreur. */
export interface SacARapporterLivreur {
  order_id: string;
  reference: string;
  restaurant: { id: string; nom: string } | null;
  /** `failed_at` (ISO). */
  depuis: string | null;
}

/** Ce que l'écriture a fait, pour les annonces. */
interface SacEcrit {
  order_id: string;
  reference: string;
  course_id: string;
  deliverer_id: string | null;
  journal: Record<string, unknown>;
}

/** La livraison a changé entre le retour à « prête » et sa suppression : tout est annulé. */
class LivraisonChangee extends Error {}

/**
 * « SAC RAPPORTÉ » (demande du 28/10). Règles : `sac-rapporte.rules.ts`.
 *
 * Le livreur a annulé la livraison d'un client (« Annuler », 27/10) : la
 * commande est restée en livraison, le sac chez lui. Il le rapporte ; la
 * caisse (ou l'ADMIN) touche « Sac rapporté ». En UNE transaction :
 *  1. la commande repasse « prête » par claim atomique (en livraison, à
 *     livrer, pas supprimée, CETTE livraison en échec, course hors Turbo) :
 *     retrait effacé, `updated_at` à maintenant (fraîcheur du planificateur),
 *     lot de l'ancien regroupement v1 effacé ; l'heure « prête » est gardée ;
 *  2. la livraison annulée est supprimée (une commande n'a qu'une livraison,
 *     et le planificateur ne prend qu'une commande sans livraison) ;
 *  3. sa copie complète est écrite au journal (SAC_RAPPORTE) ;
 *  4. les frais de l'ancienne course sont recalculés (statut inchangé).
 * Un claim perdu (double toucher, deux caisses, admin qui annule au même
 * instant) n'écrit rien : la commande est relue et la réponse le dit.
 *
 * Ensuite seulement : statut « prête » aux écrans (comme `updateStatus`) et
 * événement interne (planificateur, regroupement v1, cloche, CRM ; sans
 * notification au client), ancienne course relue au siège et au restaurant,
 * livreur prévenu (socket et « Sac rendu »). Paiements, encaissements,
 * points, coupons, ticket et Turbo ne bougent pas ; aucun changement de
 * livraison n'est annoncé.
 */
@Injectable()
export class SacRapporteService {
  private readonly logger = new Logger('Dispatch');

  constructor(
    private readonly prisma: PrismaService,
    private readonly courseEvent: CourseEvent,
    private readonly ws: CourseWebSocketService,
    private readonly orderWs: OrderWebSocketService,
    private readonly push: DelivererPushService,
  ) {}

  async sacRapporte(orderId: string, user: ComptePersonnel | undefined, maintenant = new Date()): Promise<ReponseSacRapporte> {
    let lue = await this.lire(orderId);
    // Deux essais au plus : un claim perdu relit la commande (le second ne
    // sert que si une écriture concurrente a été annulée entre-temps).
    for (let essai = 0; essai < 2; essai++) {
      if (!lue || lue.entity_status === EntityStatus.DELETED) throw new NotFoundException(MESSAGE_COMMANDE_INTROUVABLE);
      assertCommandeDuRestaurant(user, lue.restaurant_id);
      if (!estSacARapporter(lue)) return this.sansSac(lue);
      const ecrit = await this.ecrire(lue, user, maintenant);
      if (ecrit) {
        await this.annoncer(ecrit);
        return {
          order_id: lue.id,
          reference: lue.reference,
          status: OrderStatus.READY,
          livreur: this.livreurDe(lue),
          deja: false,
        };
      }
      lue = await this.lire(orderId);
    }
    if (!lue || lue.entity_status === EntityStatus.DELETED) throw new NotFoundException(MESSAGE_COMMANDE_INTROUVABLE);
    if (!estSacARapporter(lue)) return this.sansSac(lue);
    throw new ConflictException(MESSAGE_COMMANDE_CHANGEE);
  }

  /**
   * Rappel « Rapporte le sac » de l'appli : livraisons en échec des courses de
   * CE livreur (hors Turbo) depuis moins de 24 h, commande à livrer encore en
   * livraison et pas supprimée, les plus anciennes d'abord.
   */
  async sacsDuLivreur(delivererId: string, maintenant = new Date()): Promise<SacARapporterLivreur[]> {
    const lignes = await this.prisma.delivery.findMany({
      where: {
        statut: DeliveryStatut.FAILED,
        failed_at: { gte: new Date(maintenant.getTime() - SACS_A_RAPPORTER_FENETRE_MS) },
        course: { deliverer_id: delivererId, turbo_escalated_at: null },
        order: { status: OrderStatus.PICKED_UP, type: OrderType.DELIVERY, entity_status: { not: EntityStatus.DELETED } },
      },
      orderBy: { failed_at: 'asc' },
      select: {
        failed_at: true,
        order: { select: { id: true, reference: true } },
        course: { select: { restaurant: { select: { id: true, name: true } } } },
      },
    });
    return lignes.map((l) => ({
      order_id: l.order.id,
      reference: l.order.reference,
      restaurant: l.course?.restaurant ? { id: l.course.restaurant.id, nom: l.course.restaurant.name } : null,
      depuis: l.failed_at ? l.failed_at.toISOString() : null,
    }));
  }

  private lire(orderId: string): Promise<CommandeSac | null> {
    return this.prisma.order.findUnique({ where: { id: orderId }, select: SELECTION_SAC });
  }

  private livreurDe(lue: CommandeSac): ReponseSacRapporte['livreur'] {
    const d = lue.delivery?.course?.deliverer;
    return d ? { id: d.id, prenom: d.first_name ?? null } : null;
  }

  /**
   * Plus de sac à rapporter : geste déjà enregistré (200 « deja », rien n'est
   * réécrit ni émis), sinon 409 avec la raison.
   */
  private async sansSac(lue: CommandeSac): Promise<ReponseSacRapporte> {
    const trace = await this.prisma.dispatchEvenement.findFirst({
      where: { type: 'SAC_RAPPORTE', order_id: lue.id },
      orderBy: { created_at: 'desc' },
      select: { deliverer_id: true },
    });
    if (!trace) throw refusSansSac(lue.status);
    const livreur = trace.deliverer_id
      ? await this.prisma.deliverer.findUnique({ where: { id: trace.deliverer_id }, select: { id: true, first_name: true } })
      : null;
    return {
      order_id: lue.id,
      reference: lue.reference,
      status: lue.status,
      livreur: livreur ? { id: livreur.id, prenom: livreur.first_name ?? null } : null,
      deja: true,
    };
  }

  /** L'écriture d'un seul tenant ; `null` si le claim est perdu (rien n'est écrit). */
  private async ecrire(lue: CommandeSac, user: ComptePersonnel | undefined, maintenant: Date): Promise<SacEcrit | null> {
    const livraison = lue.delivery!;
    const course = livraison.course;
    const journal = {
      type: 'SAC_RAPPORTE',
      motif: livraison.failure_reason ?? null,
      source: sourceDuGeste(user),
      restaurant_id: lue.restaurant_id,
      course_id: course.id,
      deliverer_id: course.deliverer?.id ?? null,
      order_id: lue.id,
      details: copieLivraisonAnnulee({
        commande: lue.reference,
        course_reference: course.reference,
        lot: lue.batch_id ?? null,
        livraison,
        par: { id: user?.id ?? null, role: user?.role ?? null },
      }),
    };
    try {
      return await this.prisma.$transaction(async (tx) => {
        const claim = await tx.order.updateMany({
          where: {
            id: lue.id,
            status: OrderStatus.PICKED_UP,
            type: OrderType.DELIVERY,
            entity_status: { not: EntityStatus.DELETED },
            delivery: { id: livraison.id, statut: DeliveryStatut.FAILED, course: { turbo_escalated_at: null } },
          },
          data: { status: OrderStatus.READY, picked_up_at: null, updated_at: maintenant, batch_id: null },
        });
        if (claim.count !== 1) return null;

        const supprimee = await tx.delivery.deleteMany({
          where: { id: livraison.id, order_id: lue.id, statut: DeliveryStatut.FAILED },
        });
        if (supprimee.count !== 1) throw new LivraisonChangee();

        // Dans la transaction, jamais avalée : sans copie, pas de suppression.
        await tx.dispatchEvenement.create({ data: { ...journal, details: journal.details as Prisma.InputJsonValue } });
        await recalculerFraisCourse(tx, course.id);
        return {
          order_id: lue.id,
          reference: lue.reference,
          course_id: course.id,
          deliverer_id: course.deliverer?.id ?? null,
          journal,
        };
      });
    } catch (err) {
      if (err instanceof LivraisonChangee) return null;
      throw err;
    }
  }

  /** Après l'écriture : écrans, planificateur, livreur. Ne lève jamais (le geste est enregistré). */
  private async annoncer(e: SacEcrit): Promise<void> {
    this.logger.log(JSON.stringify(e.journal));

    // 1. La commande : même diffusion que `OrderService.updateStatus`, puis
    //    l'événement interne. Sans jeton : pas de notification au client.
    try {
      const commande = await this.prisma.order.findUniqueOrThrow({ where: { id: e.order_id }, include: INCLUDE_STATUT });
      this.orderWs.emitStatusUpdate(commande as unknown as Order, OrderStatus.PICKED_UP);
      this.courseEvent.statutCommandeChange({ order: commande });
    } catch (err) {
      this.logger.error(`Sac rapporté ${e.reference} : statut « prête » non annoncé (${(err as Error)?.message ?? err})`);
    }

    // 2. L'ancienne course (un arrêt de moins, frais recalculés) : siège et restaurant.
    try {
      const course = await this.prisma.course.findUnique({ where: { id: e.course_id }, include: COURSE_FULL_INCLUDE });
      if (course) {
        this.ws.emitSuiviOffre({
          course: course as unknown as CourseWithDetails,
          previous_statut: course.statut,
          new_statut: course.statut,
          reason: RAISON_SAC_RAPPORTE,
        });
      }
    } catch (err) {
      this.logger.warn(`Sac rapporté ${e.reference} : course non relue (${(err as Error)?.message ?? err})`);
    }

    // 3. Le premier livreur : son rappel « Rapporte le sac » s'arrête.
    if (e.deliverer_id) {
      try {
        this.ws.emitSacRapporte(e.deliverer_id, { order_id: e.order_id, reference: e.reference });
      } catch (err) {
        this.logger.warn(`Sac rapporté ${e.reference} : livreur non prévenu (${(err as Error)?.message ?? err})`);
      }
      this.push.notifySacRendu({ delivererId: e.deliverer_id, orderId: e.order_id, reference: e.reference });
    }
  }
}
