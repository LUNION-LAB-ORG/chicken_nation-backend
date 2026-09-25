import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DeliveryStatut, EntityStatus, OrderStatus, PromoCodeUsageStatus } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { CourseChannels } from 'src/modules/course/enums/course-channels';
import type {
  CourseCancelledPayload,
  DeliveryStatutChangedPayload,
} from 'src/modules/course/interfaces/course-event.interface';
import { OrderCouponService } from '../services/order-coupon.service';

/** Le filet regarde les annulations des dernières 48 heures… */
const FENETRE_RATTRAPAGE_MS = 48 * 60 * 60 * 1000;
/** …sauf les toutes dernières : le chemin normal est peut-être en train de rendre, avec l'agent au journal. */
const DELAI_AVANT_RATTRAPAGE_MS = 5 * 60 * 1000;
const LOT_RATTRAPAGE = 50;

/** Auteur de l'annulation d'une course, tel que le journal l'écrit. */
const COURSE_ANNULEE_PAR: Record<string, string> = {
  admin: "course annulée par l'administration",
  deliverer: 'course annulée par le livreur',
  system: 'course annulée automatiquement',
  restaurant: 'course annulée par le restaurant',
};

/**
 * RESTITUTION DES CODES PROMO ET DES BONS APRÈS UNE ANNULATION VENUE DES COURSES.
 *
 * Deux chemins du module des courses annulent une commande en écrivant
 * CANCELLED directement, sans passer par OrderService.updateStatus :
 *  - l'annulation d'une course (par le livreur, par l'administration, ou
 *    automatiquement quand la course reste bloquée) annule ses commandes
 *    encore en route ;
 *  - l'échec d'une livraison annule la commande livrée.
 *
 * Le bon d'achat ou le code promo de ces commandes restait consommé (décision
 * du 25/09 : rendu à toute annulation). Les deux chemins émettent chacun un
 * événement après avoir écrit ; on y rend le coupon. La restitution est
 * idempotente : une commande déjà rendue par un autre chemin ne l'est pas deux
 * fois.
 *
 * FILET : toutes les 10 minutes, une commande annulée depuis peu qui garde
 * une utilisation de bon ou un usage de code promo actif est rendue. Il
 * rattrape une restitution interrompue (base momentanément injoignable, juste
 * après l'annulation) : une commande annulée ne peut plus changer de statut,
 * rien d'autre ne la rejouerait. Il ne remonte jamais avant le démarrage du
 * serveur : une commande annulée avant la mise en service n'est pas touchée.
 *
 * Ne lève jamais : l'annulation est déjà enregistrée.
 */
@Injectable()
export class CouponRestitutionListener {
  private readonly logger = new Logger(CouponRestitutionListener.name);
  /** Borne basse du filet (modifiable par les tests). */
  demarrage = new Date();

  constructor(
    private readonly prisma: PrismaService,
    private readonly orderCoupon: OrderCouponService,
  ) {}

  @OnEvent(CourseChannels.COURSE_CANCELLED)
  async apresCourseAnnulee(payload: CourseCancelledPayload): Promise<void> {
    const courseId = payload?.course?.id;
    if (!courseId) return;
    try {
      const commandes = await this.prisma.order.findMany({
        where: { status: OrderStatus.CANCELLED, delivery: { course_id: courseId } },
        select: { id: true, reference: true, customer_id: true, restaurant_id: true },
      });
      const precision = COURSE_ANNULEE_PAR[payload.cancelled_by] ?? 'course annulée';
      const chemin =
        payload.cancelled_by === 'deliverer'
          ? `/courses/deliverer/${courseId}/cancel`
          : `/courses/${courseId}/cancel`;
      for (const commande of commandes) {
        await this.orderCoupon.restituerPourCommande(commande, {
          motif: 'ANNULATION',
          origine: { methode: 'PATCH', chemin, precision },
        });
      }
    } catch (e: any) {
      this.logger.error(`Restitution des coupons de la course ${courseId} impossible : ${e?.message}`);
    }
  }

  @OnEvent(CourseChannels.DELIVERY_STATUT_CHANGED)
  async apresLivraisonEchouee(payload: DeliveryStatutChangedPayload): Promise<void> {
    if (payload?.new_statut !== DeliveryStatut.FAILED) return;
    const orderId = payload.delivery?.order_id;
    if (!orderId) return;
    try {
      const commande = await this.prisma.order.findUnique({
        where: { id: orderId },
        select: { id: true, reference: true, customer_id: true, restaurant_id: true, status: true },
      });
      // Seule une commande réellement annulée rend son coupon.
      if (!commande || commande.status !== OrderStatus.CANCELLED) return;
      const { status: _statut, ...cible } = commande;
      await this.orderCoupon.restituerPourCommande(cible, {
        motif: 'ANNULATION',
        origine: {
          methode: 'PATCH',
          chemin: `/courses/deliverer/deliveries/${payload.delivery.id}/fail`,
          precision: 'livraison échouée',
        },
      });
    } catch (e: any) {
      this.logger.error(`Restitution du coupon de la commande ${orderId} (livraison échouée) impossible : ${e?.message}`);
    }
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  async rattraperRestitutions(maintenant: Date = new Date()): Promise<number> {
    const depuis = new Date(Math.max(this.demarrage.getTime(), maintenant.getTime() - FENETRE_RATTRAPAGE_MS));
    const jusqua = new Date(maintenant.getTime() - DELAI_AVANT_RATTRAPAGE_MS);
    if (jusqua.getTime() <= depuis.getTime()) return 0;
    const annulee = { status: OrderStatus.CANCELLED, cancelled_at: { gte: depuis, lte: jusqua } };
    try {
      // Lu depuis les petites tables (utilisations, usages), jamais un
      // balayage des commandes.
      const [bons, codes] = await Promise.all([
        this.prisma.redemption.findMany({
          where: { entity_status: EntityStatus.ACTIVE, order: annulee },
          select: { order_id: true },
          take: LOT_RATTRAPAGE,
        }),
        this.prisma.promoCodeUsage.findMany({
          where: { status: PromoCodeUsageStatus.ACTIVE, order: annulee },
          select: { order_id: true },
          take: LOT_RATTRAPAGE,
        }),
      ]);
      const ids = [
        ...new Set(
          [...bons, ...codes].map((l) => l.order_id).filter((id): id is string => typeof id === 'string'),
        ),
      ];
      if (ids.length === 0) return 0;

      const commandes = await this.prisma.order.findMany({
        where: { id: { in: ids } },
        select: { id: true, reference: true, customer_id: true, restaurant_id: true },
      });
      let rendues = 0;
      for (const commande of commandes) {
        const resultat = await this.orderCoupon.restituerPourCommande(commande, {
          motif: 'ANNULATION',
          origine: {
            methode: 'PATCH',
            chemin: `/orders/${commande.id}/status`,
            precision: 'rattrapage automatique',
          },
        });
        if (resultat.bons.length > 0 || resultat.codesPromo.length > 0) rendues++;
      }
      if (rendues > 0) {
        this.logger.warn(`Rattrapage : coupon rendu pour ${rendues} commande(s) annulée(s).`);
      }
      return rendues;
    } catch (e: any) {
      this.logger.error(`Rattrapage des restitutions impossible : ${e?.message}`);
      return 0;
    }
  }
}
