import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { CourseStatut, DeliveryStatut, OrderStatus, OrderType, Prisma } from '@prisma/client';

import { PrismaService } from 'src/database/services/prisma.service';
import { NotificationsSenderService } from 'src/modules/notifications/services/notifications-sender.service';
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
  raisonRelanceImpossible,
  SuiteRetrait,
  suiteDuRetrait,
} from '../helpers/detachement-commande.rules';
import { recalculerFraisCourse } from '../helpers/frais-course';
import { STATUTS_LIVRAISON_TERMINEE } from '../helpers/remise-course.rules';
import { ApplicationPlanService } from './application-plan.service';
import { CourseActionService } from './course-action.service';
import { CourseOfferService } from './course-offer.service';
import { DeliveryActionService } from './delivery-action.service';
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

/** Ce qu'on lit de la commande pour décider : sa livraison et sa course. */
const SELECTION_EXAMEN = {
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
} satisfies Prisma.OrderSelect;

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
  /** Qui change le type : un compte de restaurant, ou le siège. */
  annulee_par: 'admin' | 'restaurant';
  /** Groupe annulé chez Turbo : la course est annulée et relancée ici, que la commande change ou non. */
  turbo_annule: boolean;
  /** Décidée dans la transaction du retrait ; ne vaut que si elle a été validée. */
  suite: SuiteRetrait | null;
  /** Raison écrite sur la course annulée dans la transaction (ANNULEE, TURBO_RELANCE). */
  raison_annulation: string | null;
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
 *     avec le livreur ou si un livreur Turbo est engagé ; rien n'est écrit ;
 *  2. `annulerChezTurbo` (course confiée à Turbo, juste avant l'écriture) :
 *     leur groupe est annulé chez eux (contrat `/annuler`, sans écho de
 *     webhook) ; refus de Turbo ou réponse incertaine : 409, rien n'est écrit ;
 *  3. dans la transaction du changement de type, avant l'écriture de la
 *     commande :
 *     · `retirerDansTransaction` : course et commande encore telles que lues,
 *       livraison supprimée ; course vidée ou confiée à Turbo annulée dans la
 *       MÊME transaction (jamais une course Turbo morte laissée en recherche) ;
 *     · `verifierHorsCourse` (aucune livraison lue au début) : la commande
 *       est revendiquée, et une livraison créée entre-temps par le
 *       planificateur refuse la modification (409).
 *     Si une condition ne tient plus, toute la modification est refusée ;
 *  4. `apresEcriture` : annonces ; course terminée ou annulée annoncée ;
 *     course Turbo : ses autres commandes relancées dans une nouvelle course à
 *     référence neuve (règle de la relance), cloche si la relance échoue.
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
    // Course partie sans la commande, plus rien d'autre à livrer : elle se termine.
    private readonly livraisons: DeliveryActionService,
    // Cloche du restaurant et du siège quand une relance après Turbo échoue.
    private readonly cloche: NotificationsSenderService,
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
    auteur?: AuteurDetachement | null;
    maintenant?: Date;
  }): Promise<DetachementPrevu | null> {
    if (!quitteLaLivraison(p.typeAvant, p.typeApres)) return null;
    const typeApres = p.typeApres as OrderType;
    const commande = await this.prisma.order.findUnique({ where: { id: p.orderId }, select: SELECTION_EXAMEN });
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
      annulee_par: p.auteur?.restaurant_id ? 'restaurant' : 'admin',
      turbo_annule: false,
      suite: null,
      raison_annulation: null,
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
   *  1. la course est encore telle que lue (même livreur, pas remise
   *     entre-temps) ; sa ligne reste verrouillée jusqu'à la fin ;
   *  2. la commande est encore à livrer et au restaurant (pas remise) ;
   *  3. la livraison, pas commencée, est supprimée ;
   *  4. la suite est décidée sur la course verrouillée (`suiteDuRetrait`) :
   *     course vidée, ou confiée à Turbo, annulée ICI, dans la même
   *     transaction (statut, raison, livraisons restantes annulées). Une
   *     coupure après la validation laisse donc au pire une course annulée
   *     dont les commandes sont à relancer depuis le backoffice, jamais une
   *     course Turbo morte qui attend un livreur.
   * Une condition qui ne tient plus : 409, la transaction entière est annulée
   * (le type ne change pas).
   */
  async retirerDansTransaction(tx: Prisma.TransactionClient, d: DetachementPrevu, maintenant = new Date()): Promise<void> {
    d.suite = null;
    d.raison_annulation = null;
    const course = await tx.course.updateMany({
      where: { id: d.course_id, ...courseTelleQueLue(d) },
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

    const restantes = await tx.delivery.count({
      where: {
        course_id: d.course_id,
        statut: { notIn: STATUTS_LIVRAISON_TERMINEE },
        order: { status: { not: OrderStatus.CANCELLED } },
      },
    });
    const faites = await tx.delivery.count({
      where: { course_id: d.course_id, statut: { in: [DeliveryStatut.DELIVERED, DeliveryStatut.FAILED] } },
    });
    const suite = suiteDuRetrait({ turbo: d.cas === 'TURBO', restantes, faites });
    if (suite === 'ANNULEE' || suite === 'TURBO_RELANCE') {
      const raison =
        suite === 'TURBO_RELANCE'
          ? raisonCourseTurboRelancee(d.reference, d.type_apres)
          : raisonCourseVide(d.reference, d.type_apres);
      // La ligne est déjà verrouillée (étape 1) : écriture sous la même condition.
      const annulee = await tx.course.updateMany({
        where: { id: d.course_id, ...courseTelleQueLue(d) },
        data: {
          statut: CourseStatut.CANCELLED,
          cancelled_at: maintenant,
          // Course Turbo : annulée par le serveur, comme toute annulation chez Turbo.
          cancelled_by: d.cas === 'TURBO' ? 'system' : d.annulee_par,
          cancelled_reason: raison,
          offer_expires_at: null,
        },
      });
      if (annulee.count !== 1) throw new ConflictException(MESSAGE_COURSE_CHANGEE);
      // Livraisons restantes annulées : celles que la relance reprend (Turbo),
      // ou celles de commandes déjà annulées (course vide).
      await tx.delivery.updateMany({
        where: { course_id: d.course_id, statut: { notIn: STATUTS_LIVRAISON_TERMINEE } },
        data: { statut: DeliveryStatut.CANCELLED },
      });
      d.raison_annulation = raison;
    }
    d.suite = suite;
  }

  /**
   * Dans la transaction du changement de type, quand `examiner` n'a trouvé
   * aucune livraison à retirer : la commande est REVENDIQUÉE (sa ligne reste
   * verrouillée jusqu'à la fin), puis relue.
   *
   * Le planificateur, la création de course d'un lot et la relance
   * revendiquent la même ligne avant de rattacher la commande à une course :
   *  - s'ils passent d'abord, leur livraison se lit ici et la modification
   *    est refusée (409) : rechargée, la commande en sera retirée ;
   *  - sinon, ils attendent la fin de cette transaction et relisent une
   *    commande à emporter : ils l'abandonnent.
   */
  async verifierHorsCourse(
    tx: Prisma.TransactionClient,
    p: { orderId: string; typeApres: OrderType; maintenant?: Date },
  ): Promise<void> {
    const maintenant = p.maintenant ?? new Date();
    const tenue = await tx.order.updateMany({
      where: { id: p.orderId, type: OrderType.DELIVERY },
      data: { updated_at: maintenant },
    });
    if (tenue.count !== 1) throw new ConflictException(MESSAGE_COMMANDE_CHANGEE);
    const commande = await tx.order.findUnique({ where: { id: p.orderId }, select: SELECTION_EXAMEN });
    if (!commande?.delivery) return;
    const decision = deciderDetachement({
      statutCommande: commande.status,
      typeApres: p.typeApres,
      livraison: commande.delivery,
      maintenant,
    });
    if (decision.action === 'REFUSER') throw new ConflictException(decision.message);
    if (decision.action === 'DETACHER') throw new ConflictException(MESSAGE_COURSE_CHANGEE);
  }

  /**
   * Après l'écriture (ou son échec). Ne lève jamais : la commande est déjà
   * enregistrée, ou la modification déjà refusée.
   *
   *  - échec de l'écriture après l'annulation chez Turbo : leur groupe est
   *    mort, la course est annulée ici et toutes ses commandes encore prêtes
   *    (celle-ci comprise, toujours à livrer) repartent dans une nouvelle
   *    course ; cloche si c'est impossible ;
   *  - sinon : frais de la course recalculés, journal `COMMANDE_DETACHEE`,
   *    puis selon la suite décidée dans la transaction :
   *     · RETRAIT : annonces d'un retrait (`annoncerRetrait`) et passage du
   *       planificateur demandé ;
   *     · ANNULEE : annonces de l'annulation (offre close sans pénalité,
   *       livreur prévenu « Course annulée » et remis dans la file à sa place) ;
   *     · TERMINEE : la course se termine comme après sa dernière livraison ;
   *     · TURBO_RELANCE : annonces de l'annulation, puis les autres commandes
   *       relancées ; cloche si la relance échoue.
   */
  async apresEcriture(d: DetachementPrevu, issue: { ecrit: boolean; maintenant?: Date }): Promise<void> {
    try {
      if (!issue.ecrit) {
        if (d.turbo_annule) await this.annulerEtRelancer(d);
        return;
      }
      const maintenant = issue.maintenant ?? new Date();
      const source: SourceDispatch = d.annulee_par === 'restaurant' ? 'restaurant' : 'admin';
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

      switch (d.suite) {
        case 'RETRAIT':
          await this.plan.annoncerRetrait(d.course_id, [d.reference], maintenant);
          this.courseEvent.demanderPlanification({ restaurant_id: d.restaurant_id, raison: 'COMMANDE_DETACHEE' });
          return;
        case 'TERMINEE':
          await this.livraisons.checkCourseCompletion(d.course_id);
          return;
        case 'ANNULEE':
          await this.annoncerAnnulation(d);
          return;
        case 'TURBO_RELANCE':
          await this.annoncerAnnulation(d);
          await this.relancer(d);
          return;
      }
    } catch (err) {
      this.logger.error(
        `Commande ${d.reference} retirée de la course ${d.course_reference} : suites en échec (${(err as Error)?.message ?? err}).`,
      );
    }
  }

  /** Course annulée dans la transaction du retrait : mêmes annonces que l'annulation ordinaire. */
  private async annoncerAnnulation(d: DetachementPrevu): Promise<void> {
    const course = await this.prisma.course.findUnique({ where: { id: d.course_id }, include: COURSE_FULL_INCLUDE });
    if (!course) return;
    await this.actions.annoncerAnnulation(course, course.cancelled_by ?? 'system', course.cancelled_reason ?? d.raison_annulation ?? '');
  }

  /**
   * Course Turbo annulée (chez eux et ici) : ses commandes encore prêtes
   * repartent dans une NOUVELLE course, à référence neuve (Turbo refuse en
   * silence une référence déjà reçue), envoyée à Turbo ou proposée aux
   * livreurs selon leur flotte. Échec : cloche du restaurant et du siège, la
   * course reste annulée avec ses commandes à relancer depuis le backoffice.
   */
  private async relancer(d: DetachementPrevu): Promise<void> {
    let echec: string | null = null;
    try {
      const relance = await this.offres.relancerCourseAnnulee(d.course_id);
      if (relance.ok) {
        await recalculerFraisCourse(this.prisma, d.course_id).catch(() => undefined);
        this.logger.log(`Course Turbo ${d.course_reference} annulée chez Turbo : ${relance.message}`);
        return;
      }
      echec = relance.message;
    } catch (err) {
      echec = (err as Error)?.message ?? String(err);
    }
    this.logger.error(`Course Turbo ${d.course_reference} : relance impossible (${echec}).`);
    await this.sonnerRelanceImpossible(d);
  }

  /**
   * L'écriture a échoué APRÈS l'annulation chez Turbo : leur groupe est mort.
   * La course est annulée ici (annulation ordinaire, sous condition) et toutes
   * ses commandes repartent, celle-ci comprise. Échec : cloche.
   */
  private async annulerEtRelancer(d: DetachementPrevu): Promise<void> {
    const annulee = await this.actions
      .cancelCourse(d.course_id, 'system', { reason: RAISON_TURBO_SANS_CHANGEMENT })
      .then(() => true)
      .catch((err) => {
        this.logger.error(`Course Turbo ${d.course_reference} non annulée : ${(err as Error)?.message ?? err}`);
        return false;
      });
    if (!annulee) {
      await this.sonnerRelanceImpossible(d);
      return;
    }
    await this.relancer(d);
  }

  /** Cloche « Course annulée par Turbo » : les commandes restent actives, à relancer à la main. */
  private async sonnerRelanceImpossible(d: DetachementPrevu): Promise<void> {
    const livraisons = await this.prisma.delivery
      .findMany({
        where: { course_id: d.course_id, order: { status: { not: OrderStatus.CANCELLED } } },
        select: { order: { select: { reference: true } } },
      })
      .catch(() => [] as { order: { reference: string } }[]);
    await this.cloche
      .sendTurboCourseCancelledBell({
        courseReference: d.course_reference,
        restaurantId: d.restaurant_id,
        orderReferences: livraisons.map((l) => l.order.reference),
        raison: raisonRelanceImpossible(d.reference, d.type_apres),
      })
      .catch(() => undefined);
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
        // Course partie : la commande est restée au comptoir (vérifié sur la
        // commande et sa livraison), le retrait vaut avant comme après le départ.
        statut:
          d.statut_course === CourseStatut.IN_DELIVERY
            ? CourseStatut.IN_DELIVERY
            : { in: [CourseStatut.ACCEPTED, CourseStatut.AT_RESTAURANT] },
      };
    case 'SANS_LIVREUR':
      return { statut: d.statut_course, deliverer_id: d.deliverer_id, turbo_escalated_at: null };
  }
}
