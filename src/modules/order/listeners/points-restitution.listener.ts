import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DeliveryStatut, LoyaltyPointType, OrderStatus, Prisma } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { CourseChannels } from 'src/modules/course/enums/course-channels';
import type {
  CourseCancelledPayload,
  DeliveryStatutChangedPayload,
} from 'src/modules/course/interfaces/course-event.interface';
import { LoyaltyService } from 'src/modules/fidelity/services/loyalty.service';

/** Le filet regarde les annulations des dernières 48 heures… */
const FENETRE_RATTRAPAGE_MS = 48 * 60 * 60 * 1000;
/** …sauf les toutes dernières : le chemin normal est peut-être en train de rendre. */
const DELAI_AVANT_RATTRAPAGE_MS = 5 * 60 * 1000;
const LOT_RATTRAPAGE = 50;

/**
 * POINTS UTILISÉS RENDUS QUAND L'ANNULATION NE PASSE PAS PAR updateStatus (02/10).
 *
 * Les points d'une commande payée en ligne sont retirés dès le paiement. Ils
 * sont rendus à l'annulation par `OrderListenerService`, qui écoute le
 * changement de statut. Deux chemins du module des courses annulent pourtant
 * une commande en écrivant CANCELLED directement, sans cet événement : la
 * course annulée (livreur, administration, annulation automatique) et la
 * livraison échouée. Sans ce relais, une livraison payée avec des points puis
 * annulée en route coûtait ses points au client.
 *
 * Même organisation que `CouponRestitutionListener`, qui rend les coupons de
 * ces mêmes annulations : un relais par événement, et un FILET toutes les
 * 10 minutes pour une restitution interrompue (base momentanément
 * injoignable), quel que soit le chemin d'annulation. Le filet ne remonte
 * jamais avant le démarrage du serveur.
 *
 * `LoyaltyService.rendrePointsUtilises` est idempotent : une commande déjà
 * rendue par un autre chemin ne l'est pas deux fois. Ne lève jamais :
 * l'annulation est déjà enregistrée.
 */
@Injectable()
export class PointsRestitutionListener {
  private readonly logger = new Logger(PointsRestitutionListener.name);
  /** Borne basse du filet (modifiable par les tests). */
  demarrage = new Date();

  constructor(
    private readonly prisma: PrismaService,
    private readonly loyaltyService: LoyaltyService,
  ) {}

  @OnEvent(CourseChannels.COURSE_CANCELLED)
  async apresCourseAnnulee(payload: CourseCancelledPayload): Promise<void> {
    const courseId = payload?.course?.id;
    if (!courseId) return;
    try {
      // Lu depuis les lignes de retrait : seules les commandes déduites ont
      // quelque chose à rendre.
      const retraits = await this.prisma.loyaltyPoint.findMany({
        where: {
          type: LoyaltyPointType.REDEEMED,
          order: { status: OrderStatus.CANCELLED, delivery: { course_id: courseId } },
        },
        select: { order_id: true },
      });
      await this.rendre(retraits);
    } catch (e: any) {
      this.logger.error(`Restitution des points de la course ${courseId} impossible : ${e?.message}`);
    }
  }

  @OnEvent(CourseChannels.DELIVERY_STATUT_CHANGED)
  async apresLivraisonEchouee(payload: DeliveryStatutChangedPayload): Promise<void> {
    if (payload?.new_statut !== DeliveryStatut.FAILED) return;
    const orderId = payload.delivery?.order_id;
    if (!orderId) return;
    try {
      // Ne rend rien si la commande n'est pas annulée ou n'a jamais été déduite.
      await this.loyaltyService.rendrePointsUtilises(orderId);
    } catch (e: any) {
      this.logger.error(`Restitution des points de la commande ${orderId} (livraison échouée) impossible : ${e?.message}`);
    }
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  async rattraperRestitutions(maintenant: Date = new Date()): Promise<number> {
    const depuis = new Date(Math.max(this.demarrage.getTime(), maintenant.getTime() - FENETRE_RATTRAPAGE_MS));
    const jusqua = new Date(maintenant.getTime() - DELAI_AVANT_RATTRAPAGE_MS);
    if (jusqua.getTime() <= depuis.getTime()) return 0;
    try {
      // Une ligne de retrait encore REDEEMED sur une commande annulée : ses
      // points n'ont pas été rendus. Lu depuis les lignes de points, jamais
      // un balayage des commandes.
      const where: Prisma.LoyaltyPointWhereInput = {
        type: LoyaltyPointType.REDEEMED,
        order: { status: OrderStatus.CANCELLED, cancelled_at: { gte: depuis, lte: jusqua } },
      };
      const retraits = await this.prisma.loyaltyPoint.findMany({
        where,
        select: { order_id: true },
        take: LOT_RATTRAPAGE,
      });
      const rendues = await this.rendre(retraits);
      if (rendues > 0) {
        this.logger.warn(`Rattrapage : points rendus pour ${rendues} commande(s) annulée(s).`);
      }
      return rendues;
    } catch (e: any) {
      this.logger.error(`Rattrapage des points à rendre impossible : ${e?.message}`);
      return 0;
    }
  }

  /** Rend commande par commande ; un échec n'empêche pas les suivantes. */
  private async rendre(retraits: { order_id: string | null }[]): Promise<number> {
    const ids = [...new Set(retraits.map((r) => r.order_id).filter((id): id is string => typeof id === 'string'))];
    let rendues = 0;
    for (const id of ids) {
      try {
        const { points_rendus } = await this.loyaltyService.rendrePointsUtilises(id);
        if (points_rendus > 0) rendues++;
      } catch (e: any) {
        this.logger.error(`Restitution des points de la commande ${id} impossible : ${e?.message}`);
      }
    }
    return rendues;
  }
}
