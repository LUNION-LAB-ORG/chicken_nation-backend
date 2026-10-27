import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { CourseStatut, DeliveryStatut, OrderStatus, OrderType, Prisma } from '@prisma/client';

import { PrismaService } from 'src/database/services/prisma.service';
import { TurboService } from 'src/turbo/services/turbo.service';

import { CourseEvent } from '../events/course.event';
import { COURSE_FULL_INCLUDE } from '../helpers/course.includes';
import {
  CasDetachement,
  deciderDetachement,
  libelleNouveauType,
  MESSAGE_COURSE_CHANGEE,
  MESSAGE_TURBO_INCERTAIN,
  messageLivreurTurboEngage,
  quitteLaLivraison,
  RAISON_TURBO_SANS_CHANGEMENT,
  raisonCourseTurboRelancee,
  raisonCourseVide,
} from '../helpers/detachement-commande.rules';
import { recalculerFraisCourse } from '../helpers/frais-course';
import { STATUTS_LIVRAISON_TERMINEE } from '../helpers/remise-course.rules';
import { ApplicationPlanService } from './application-plan.service';
import { CourseActionService } from './course-action.service';
import { CourseOfferService } from './course-offer.service';
import { DispatchJournalService, SourceDispatch } from './dispatch-journal.service';

/** Commande encore au restaurant : la seule qu'on retire d'une course. */
const STATUTS_COMMANDE_AU_RESTAURANT: OrderStatus[] = [
  OrderStatus.PENDING,
  OrderStatus.ACCEPTED,
  OrderStatus.IN_PROGRESS,
  OrderStatus.READY,
];

/** Même texte que « Modifier la commande » quand la commande a changé entre la lecture et l'écriture. */
const MESSAGE_COMMANDE_CHANGEE = 'Cette commande vient de changer : rechargez-la avant de la modifier.';

/** Livraison d'une commande à retirer de sa course, telle que lue avant l'écriture. */
export interface DetachementPrevu {
  cas: CasDetachement;
  order_id: string;
  reference: string;
  type_apres: OrderType;
  livraison_id: string;
  course_id: string;
  course_reference: string;
  restaurant_id: string;
  statut_course: CourseStatut;
  deliverer_id: string | null;
  /** Groupe annulé chez Turbo : la course est annulée et relancée ici, que la commande change ou non. */
  turbo_annule: boolean;
}

/** Qui change le type : un compte de restaurant, ou le siège. */
export interface AuteurDetachement {
  restaurant_id?: string | null;
}

/**
 * COMMANDE À LIVRER PASSÉE À EMPORTER OU SUR PLACE (demande du 27/10) : sa
 * livraison est retirée de sa course, par le même geste qu'une commande
 * détachée au départ du livreur (`ApplicationPlanService.detacher`,
 * `DepartCourseService.enregistrerDepart`) : suppression conditionnée de la
 * livraison, frais de la course recalculés, journal `COMMANDE_DETACHEE`,
 * `course:statut:changed` raison COMMANDE_DETACHEE, « Commande retirée » au
 * livreur. Règles : `detachement-commande.rules.ts`.
 *
 * Appelé par `OrderService.update`, en quatre temps :
 *  1. `examiner` (lecture seule, au début) : refus clair en 409 si le sac est
 *     avec le livreur, si la course est partie ou si un livreur Turbo est
 *     engagé ; rien n'est écrit ;
 *  2. `annulerChezTurbo` (course confiée à Turbo, juste avant l'écriture) :
 *     leur groupe est annulé chez eux (contrat `/annuler`, sans écho de
 *     webhook) ; refus de Turbo ou réponse incertaine : 409, rien n'est écrit ;
 *  3. `retirerDansTransaction` (dans la transaction du changement de type) :
 *     course et commande encore telles que lues, livraison supprimée. Si la
 *     condition ne tient plus, toute la modification est refusée (409) ;
 *  4. `apresEcriture` : annonces, et course vide annulée (jamais la
 *     commande), offre close sans pénalité, livreur remis dans la file à sa
 *     place. Course Turbo : annulée ici aussi, ses autres commandes relancées
 *     dans une nouvelle course à référence neuve (règle de la relance).
 *
 * Les paiements, les encaissements, les frais et le montant de la commande
 * ne sont pas touchés ici : ils suivent la règle du changement de type.
 */
@Injectable()
export class DetachementCommandeService {
  private readonly logger = new Logger('Dispatch');

  constructor(
    private readonly prisma: PrismaService,
    private readonly plan: ApplicationPlanService,
    private readonly actions: CourseActionService,
    private readonly offres: CourseOfferService,
    private readonly turbo: TurboService,
    private readonly journal: DispatchJournalService,
    private readonly courseEvent: CourseEvent,
  ) {}

  /**
   * Lecture seule : la commande quitte-t-elle une course, et le peut-elle ?
   *
   * @returns `null` s'il n'y a rien à retirer (type inchangé, pas de course,
   *   livraison ou course terminée, commande annulée).
   * @throws ConflictException avec le motif en clair si le changement de type
   *   doit être refusé.
   */
  async examiner(p: {
    orderId: string;
    typeAvant: OrderType;
    typeApres?: OrderType | null;
    maintenant?: Date;
  }): Promise<DetachementPrevu | null> {
    if (!quitteLaLivraison(p.typeAvant, p.typeApres)) return null;
    const typeApres = p.typeApres as OrderType;
    const commande = await this.prisma.order.findUnique({
      where: { id: p.orderId },
      select: {
        id: true,
        reference: true,
        status: true,
        delivery: {
          select: {
            id: true,
            statut: true,
            course: {
              select: {
                id: true,
                reference: true,
                restaurant_id: true,
                statut: true,
                deliverer_id: true,
                parti_at: true,
                turbo_escalated_at: true,
                deliveries: { select: { turbo_courier_id: true } },
              },
            },
          },
        },
      },
    });
    if (!commande?.delivery) return null;

    const decision = deciderDetachement({
      statutCommande: commande.status,
      typeApres,
      livraison: commande.delivery,
      maintenant: p.maintenant ?? new Date(),
    });
    if (decision.action === 'RIEN') return null;
    if (decision.action === 'REFUSER') throw new ConflictException(decision.message);

    const course = commande.delivery.course;
    return {
      cas: decision.cas,
      order_id: commande.id,
      reference: commande.reference,
      type_apres: typeApres,
      livraison_id: commande.delivery.id,
      course_id: course.id,
      course_reference: course.reference,
      restaurant_id: course.restaurant_id,
      statut_course: course.statut,
      deliverer_id: course.deliverer_id,
      turbo_annule: false,
    };
  }

  /**
   * Course confiée à Turbo : leur groupe est annulé CHEZ EUX avant toute
   * écriture (jamais un livreur Turbo pour une commande que le client vient
   * chercher). Turbo ne sait annuler qu'un groupe entier : ses autres
   * commandes sont relancées après l'écriture (`apresEcriture`).
   *
   * @throws ConflictException si un livreur Turbo a déjà accepté (409 chez
   *   eux) ou si l'issue est incertaine (réseau, réponse inattendue) : leur
   *   course est peut-être vivante, la commande reste à livrer.
   */
  async annulerChezTurbo(d: DetachementPrevu): Promise<void> {
    if (d.cas !== 'TURBO' || d.turbo_annule) return;
    // Clé lue à part : elle ne voyage jamais avec la course.
    const resto = await this.prisma.restaurant.findUnique({
      where: { id: d.restaurant_id },
      select: { apikey: true },
    });
    const annulation = await this.turbo.annulerCourseGroupe({
      referenceCourse: d.course_reference,
      apikey: resto?.apikey ?? '',
    });
    if (!annulation.ok) {
      throw new ConflictException(
        annulation.courierAssigned ? messageLivreurTurboEngage(d.type_apres) : MESSAGE_TURBO_INCERTAIN,
      );
    }
    d.turbo_annule = true;
  }

  /**
   * Dans la transaction du changement de type, AVANT l'écriture de la
   * commande (même ordre de verrous que la remise au comptoir et le
   * planificateur : la course, puis la commande) :
   *  1. la course est encore telle que lue (même livreur, pas partie, pas
   *     remise entre-temps) ; sa ligne reste verrouillée jusqu'à la fin ;
   *  2. la commande est encore à livrer et au restaurant (pas remise) ;
   *  3. la livraison, pas commencée, est supprimée.
   * Une condition qui ne tient plus : 409, la transaction entière est annulée
   * (le type ne change pas).
   */
  async retirerDansTransaction(tx: Prisma.TransactionClient, d: DetachementPrevu, maintenant = new Date()): Promise<void> {
    const course = await tx.course.updateMany({
      where: { id: d.course_id, parti_at: null, ...courseTelleQueLue(d) },
      data: { updated_at: maintenant },
    });
    if (course.count !== 1) throw new ConflictException(MESSAGE_COURSE_CHANGEE);

    const commande = await tx.order.updateMany({
      where: { id: d.order_id, type: OrderType.DELIVERY, status: { in: STATUTS_COMMANDE_AU_RESTAURANT } },
      data: { updated_at: maintenant },
    });
    if (commande.count !== 1) throw new ConflictException(MESSAGE_COMMANDE_CHANGEE);

    const { count } = await tx.delivery.deleteMany({
      where: { id: d.livraison_id, course_id: d.course_id, order_id: d.order_id, statut: DeliveryStatut.PENDING },
    });
    if (count !== 1) throw new ConflictException(MESSAGE_COURSE_CHANGEE);
  }

  /**
   * Après l'écriture (ou son échec). Ne lève jamais : la commande est déjà
   * enregistrée, ou la modification déjà refusée.
   *
   *  - échec de l'écriture après l'annulation chez Turbo : leur groupe est
   *    mort, la course est annulée ici et toutes ses commandes encore prêtes
   *    (celle-ci comprise, toujours à livrer) repartent dans une nouvelle
   *    course ;
   *  - sinon : frais de la course recalculés, journal `COMMANDE_DETACHEE`,
   *    puis selon la course :
   *     · Turbo : annulée ici aussi, ses autres commandes relancées ;
   *     · plus aucune commande à livrer : annulée (offre close sans pénalité,
   *       livreur prévenu « Course annulée » et remis dans la file à sa place) ;
   *     · sinon : annonces d'un retrait (`annoncerRetrait`) et passage du
   *       planificateur demandé.
   */
  async apresEcriture(
    d: DetachementPrevu,
    issue: { ecrit: boolean; auteur?: AuteurDetachement | null; maintenant?: Date },
  ): Promise<void> {
    try {
      if (!issue.ecrit) {
        if (d.turbo_annule) await this.annulerEtRelancer(d, RAISON_TURBO_SANS_CHANGEMENT);
        return;
      }
      const maintenant = issue.maintenant ?? new Date();
      const source: SourceDispatch = issue.auteur?.restaurant_id ? 'restaurant' : 'admin';
      await recalculerFraisCourse(this.prisma, d.course_id).catch(() => undefined);
      await this.journal.ecrire({
        type: 'COMMANDE_DETACHEE',
        motif: d.type_apres === OrderType.TABLE ? 'PASSEE_SUR_PLACE' : 'PASSEE_A_EMPORTER',
        source,
        restaurant_id: d.restaurant_id,
        course_id: d.course_id,
        deliverer_id: d.deliverer_id,
        order_id: d.order_id,
        details: {
          commande: d.reference,
          libelle: `${d.reference} passée ${libelleNouveauType(d.type_apres)} : retirée de la course`,
          ...(d.cas === 'TURBO' ? { turbo: true } : {}),
        },
      });

      const restantes = await this.prisma.delivery.count({
        where: {
          course_id: d.course_id,
          statut: { notIn: STATUTS_LIVRAISON_TERMINEE },
          order: { status: { not: OrderStatus.CANCELLED } },
        },
      });
      if (d.cas === 'TURBO') {
        await this.annulerEtRelancer(
          d,
          restantes > 0 ? raisonCourseTurboRelancee(d.reference, d.type_apres) : raisonCourseVide(d.reference, d.type_apres),
        );
        return;
      }
      if (restantes === 0) {
        await this.annulerCourseVide(d, source === 'restaurant' ? 'restaurant' : 'admin', maintenant);
        return;
      }
      await this.plan.annoncerRetrait(d.course_id, [d.reference], maintenant);
      this.courseEvent.demanderPlanification({ restaurant_id: d.restaurant_id, raison: 'COMMANDE_DETACHEE' });
    } catch (err) {
      this.logger.error(
        `Commande ${d.reference} retirée de la course ${d.course_reference} : suites en échec (${(err as Error)?.message ?? err}).`,
      );
    }
  }

  /**
   * Plus aucune commande à livrer : la course est annulée par l'annulation
   * ordinaire (`cancelCourse`), jamais la commande. Annulée par le siège ou
   * le restaurant : le livreur n'y est pour rien, il reprend sa place dans la
   * file ; son offre en attente est close sans pénalité.
   *
   * Course expirée (aucun livreur trouvé) : l'annulation ordinaire la tient
   * pour terminée ; elle est annulée ici, sous condition qu'elle soit
   * toujours expirée et vide, pour qu'une relance ne propose pas une course
   * sans commande.
   */
  private async annulerCourseVide(d: DetachementPrevu, annuleePar: 'admin' | 'restaurant', maintenant: Date): Promise<void> {
    const raison = raisonCourseVide(d.reference, d.type_apres);
    if (d.statut_course !== CourseStatut.EXPIRED) {
      await this.actions.cancelCourse(d.course_id, annuleePar, { reason: raison }).catch((err) => {
        this.logger.warn(`Course ${d.course_reference} vide non annulée : ${(err as Error)?.message ?? err}`);
      });
      return;
    }
    const { count } = await this.prisma.course.updateMany({
      where: {
        id: d.course_id,
        statut: CourseStatut.EXPIRED,
        deliveries: {
          none: { statut: { notIn: STATUTS_LIVRAISON_TERMINEE }, order: { status: { not: OrderStatus.CANCELLED } } },
        },
      },
      data: { statut: CourseStatut.CANCELLED, cancelled_at: maintenant, cancelled_by: annuleePar, cancelled_reason: raison },
    });
    if (count !== 1) return;
    await this.prisma.delivery.updateMany({
      where: { course_id: d.course_id, statut: { notIn: STATUTS_LIVRAISON_TERMINEE } },
      data: { statut: DeliveryStatut.CANCELLED },
    });
    const course = await this.prisma.course.findUnique({ where: { id: d.course_id }, include: COURSE_FULL_INCLUDE });
    if (course) await this.courseEvent.courseCancelled({ course, cancelled_by: annuleePar, reason: raison });
  }

  /**
   * Groupe annulé chez Turbo : la course est annulée ici aussi (annulation
   * ordinaire ; une course confiée à Turbo n'y relance rien d'office), puis
   * ses commandes encore prêtes repartent dans une NOUVELLE course, à
   * référence neuve (Turbo refuse en silence une référence déjà reçue),
   * envoyée à Turbo ou proposée aux livreurs selon leur flotte.
   */
  private async annulerEtRelancer(d: DetachementPrevu, raison: string): Promise<void> {
    await this.actions.cancelCourse(d.course_id, 'system', { reason: raison }).catch((err) => {
      this.logger.warn(`Course Turbo ${d.course_reference} non annulée : ${(err as Error)?.message ?? err}`);
    });
    const relance = await this.offres.relancerCourseAnnulee(d.course_id).catch((err) => {
      this.logger.error(`Course Turbo ${d.course_reference} : relance impossible (${(err as Error)?.message ?? err}).`);
      return null;
    });
    if (relance?.ok) {
      await recalculerFraisCourse(this.prisma, d.course_id).catch(() => undefined);
      this.logger.log(`Course Turbo ${d.course_reference} annulée chez Turbo : ${relance.message}`);
    }
  }
}

/** Condition d'écriture : la course est encore dans l'état qui a décidé du retrait. */
function courseTelleQueLue(d: DetachementPrevu): Prisma.CourseWhereInput {
  switch (d.cas) {
    case 'TURBO':
      return {
        statut: CourseStatut.PENDING_ASSIGNMENT,
        turbo_escalated_at: { not: null },
        deliveries: { none: { turbo_courier_id: { not: null } } },
      };
    case 'AVEC_LIVREUR':
      return {
        deliverer_id: d.deliverer_id,
        turbo_escalated_at: null,
        // Le GPS fait passer « au restaurant » à tout moment : ce n'est pas un retrait.
        statut:
          d.statut_course === CourseStatut.IN_DELIVERY
            ? CourseStatut.IN_DELIVERY
            : { in: [CourseStatut.ACCEPTED, CourseStatut.AT_RESTAURANT] },
      };
    case 'SANS_LIVREUR':
      return { statut: d.statut_course, deliverer_id: d.deliverer_id, turbo_escalated_at: null };
  }
}
