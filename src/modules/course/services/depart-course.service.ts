import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CourseStatut, DeliveryStatut, OrderStatus, Prisma } from '@prisma/client';

import { PrismaService } from 'src/database/services/prisma.service';
import { DelivererPushService } from 'src/modules/deliverers/services/deliverer-push.service';

import { CourseEvent } from '../events/course.event';
import { RaisonsPlanificateur, texteCommandeRemise } from '../helpers/application-plan.rules';
import { CourseSettingsHelper } from '../helpers/course-settings.helper';
import { COURSE_FULL_INCLUDE } from '../helpers/course.includes';
import {
  motifFermetureALaValidation,
  MESSAGE_DEPART_AVANT_RETRAIT,
  MESSAGE_LIVREUR_PARTI,
  MESSAGE_RIEN_A_REMETTRE,
  MESSAGE_COURSE_PAS_A_TOI,
} from '../helpers/depart.rules';
import { planificateurDuRestaurant } from '../helpers/planification.rules';
import { STATUTS_LIVRAISON_TERMINEE } from '../helpers/remise-course.rules';
import { DispatchJournalService, SourceDispatch } from './dispatch-journal.service';

type CourseDetaillee = Prisma.CourseGetPayload<{ include: typeof COURSE_FULL_INCLUDE }>;

/**
 * DÉPART DU RESTAURANT ET RETRAIT COMPLÉMENTAIRE (planificateur v2,
 * conception 3.8 ; demande 4 du 22/10).
 *
 * Après la validation du retrait, la course reste « au restaurant » tant que
 * `Course.parti_at` est nul : une commande compatible qui devient prête peut
 * encore lui être ajoutée (planificateur) puis remise avec le MÊME code.
 *
 *  - FENÊTRE FERMÉE D'OFFICE à la validation (`parti_at` posé tout de suite)
 *    pour un livreur dont l'appli ne sait pas afficher un ajout après le
 *    retrait (`protocole_appli` < 3 : il partirait sans le plat), quand le
 *    réglage `course.ajout_apres_retrait` est coupé, pour une course sans
 *    livreur interne (Turbo), et pour un restaurant en v1 (rien ne change
 *    pour lui) ;
 *  - BOUTON « Je pars » de la nouvelle appli (`POST /courses/deliverer/:id/depart`) ;
 *  - les autres signaux (position hors du rayon de départ, première livraison
 *    commencée, fenêtre écoulée) sont lus par le planificateur à son passage ;
 *  - RETRAIT COMPLÉMENTAIRE : la caisse saisit le même code, seules les
 *    commandes prêtes sont remises, la course reste en livraison, le livreur
 *    est prévenu (« Tout est récupéré »).
 */
@Injectable()
export class DepartCourseService {
  private readonly logger = new Logger(DepartCourseService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: CourseSettingsHelper,
    private readonly courseEvent: CourseEvent,
    private readonly push: DelivererPushService,
    private readonly journal: DispatchJournalService,
  ) {}

  /**
   * Juste après la validation du retrait (code, bouton de la caisse, route du
   * livreur) : ferme la fenêtre d'ajout si elle ne doit pas s'ouvrir.
   *
   * @returns vrai si `parti_at` a été posé.
   */
  async fermerFenetreALaValidation(courseId: string, maintenant = new Date()): Promise<boolean> {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: {
        id: true,
        reference: true,
        restaurant_id: true,
        statut: true,
        parti_at: true,
        deliverer_id: true,
        deliverer: { select: { protocole_appli: true } },
      },
    });
    if (!course || course.statut !== CourseStatut.IN_DELIVERY || course.parti_at) return false;

    const lue = await this.settings.lirePlanification();
    const version = planificateurDuRestaurant(lue.planificateur, course.restaurant_id);
    const motif = motifFermetureALaValidation({
      version,
      deliverer_id: course.deliverer_id,
      protocole_appli: course.deliverer?.protocole_appli ?? null,
      reglages: lue.planification.reglages,
    });
    if (!motif) return false;

    const { count } = await this.prisma.course.updateMany({
      where: { id: courseId, statut: CourseStatut.IN_DELIVERY, parti_at: null },
      data: { parti_at: maintenant },
    });
    if (count === 1 && version === 'v2') {
      await this.journal.ecrire({
        type: 'COURSE_PARTIE',
        motif,
        source: 'serveur',
        restaurant_id: course.restaurant_id,
        course_id: course.id,
        deliverer_id: course.deliverer_id,
        details: { course: course.reference, a_la_validation: true },
      });
    }
    return count === 1;
  }

  /**
   * Validation du retrait par le code : une commande ajoutée à la course
   * pendant la saisie de la caisse n'a pas été remise (seules les commandes
   * vues par la caisse passent « récupérées »). Elle est marquée comme ajoutée
   * après le retrait : remise ensuite avec le même code, ou retirée de la
   * course au départ du livreur (planificateur, et repli v1).
   */
  async marquerAjoutsPendantLaRemise(courseId: string, commandesRemises: string[]): Promise<number> {
    const { count } = await this.prisma.delivery.updateMany({
      where: {
        course_id: courseId,
        order_id: { notIn: commandesRemises },
        statut: DeliveryStatut.PENDING,
        order: { status: OrderStatus.READY },
      },
      data: { ajoutee_apres_retrait: true },
    });
    if (count > 0) {
      this.logger.warn(`Course ${courseId.slice(0, 8)} : ${count} commande(s) ajoutée(s) pendant la remise, à remettre.`);
    }
    return count;
  }

  /**
   * Bouton « Je pars » du livreur. Idempotent : une course déjà partie rend
   * simplement la course. Une commande ajoutée après le retrait et pas encore
   * remise est retirée de la course par le passage du planificateur demandé
   * ici (elle repart dans une autre course). La retenue éventuelle est levée.
   */
  async jePars(courseId: string, delivererId: string, maintenant = new Date()): Promise<CourseDetaillee> {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: { id: true, reference: true, restaurant_id: true, deliverer_id: true, statut: true, parti_at: true },
    });
    if (!course) throw new NotFoundException('Course non trouvée');
    if (course.deliverer_id !== delivererId) throw new ForbiddenException(MESSAGE_COURSE_PAS_A_TOI);
    if (course.statut !== CourseStatut.IN_DELIVERY) throw new BadRequestException(MESSAGE_DEPART_AVANT_RETRAIT);

    if (!course.parti_at) {
      const { count } = await this.prisma.course.updateMany({
        where: { id: courseId, statut: CourseStatut.IN_DELIVERY, parti_at: null },
        data: { parti_at: maintenant },
      });
      if (count === 1) {
        await this.prisma.course.updateMany({
          where: { id: courseId, retenue_jusqua: { gt: maintenant } },
          data: { retenue_jusqua: maintenant, commandes_attendues: [] },
        });
        await this.journal.ecrire({
          type: 'COURSE_PARTIE',
          motif: 'BOUTON',
          source: 'appli',
          restaurant_id: course.restaurant_id,
          course_id: course.id,
          deliverer_id: delivererId,
          details: { course: course.reference },
        });
      }
    }

    const detaillee = await this.prisma.course.findUniqueOrThrow({ where: { id: courseId }, include: COURSE_FULL_INCLUDE });
    await this.courseEvent.courseStatutChanged({
      course: detaillee,
      previous_statut: CourseStatut.IN_DELIVERY,
      new_statut: CourseStatut.IN_DELIVERY,
      reason: RaisonsPlanificateur.DEPART,
    });
    // Commandes ajoutées pas remises : retirées par le planificateur (et reprises ailleurs).
    this.courseEvent.demanderPlanification({ restaurant_id: course.restaurant_id, raison: 'JE_PARS' });
    return detaillee;
  }

  /**
   * RETRAIT COMPLÉMENTAIRE par le code de retrait : course récupérée, livreur
   * encore au restaurant. Seules les commandes prêtes sont remises (les déjà
   * remises sont ignorées) ; la course reste en livraison. Écriture
   * conditionnée : si le livreur vient de partir, 409 et rien n'est remis.
   */
  async remettreComplement(
    course: CourseDetaillee,
    source: SourceDispatch = 'caisse',
    maintenant = new Date(),
  ): Promise<CourseDetaillee> {
    const aRemettre = course.deliveries.filter(
      (d) => !STATUTS_LIVRAISON_TERMINEE.includes(d.statut) && d.order.status === OrderStatus.READY,
    );
    if (aRemettre.length === 0) throw new ConflictException(MESSAGE_RIEN_A_REMETTRE);

    await this.prisma.$transaction(async (tx) => {
      const encore = await tx.course.updateMany({
        where: { id: course.id, statut: CourseStatut.IN_DELIVERY, parti_at: null },
        data: { updated_at: maintenant },
      });
      if (encore.count !== 1) throw new ConflictException(MESSAGE_LIVREUR_PARTI);
      await tx.order.updateMany({
        where: { id: { in: aRemettre.map((d) => d.order.id) }, status: OrderStatus.READY },
        data: { status: OrderStatus.PICKED_UP, picked_up_at: maintenant },
      });
    });

    const references = aRemettre.map((d) => d.order.reference);
    await this.journal.ecrire({
      type: 'RETRAIT_COMPLEMENTAIRE',
      source,
      restaurant_id: course.restaurant_id,
      course_id: course.id,
      deliverer_id: course.deliverer_id,
      details: { course: course.reference, commandes: references },
    });
    const detaillee = await this.annoncerToutRecupere(course.id);
    this.logger.log(`Course ${course.reference} : retrait complémentaire (${references.join(', ')}), même code.`);
    return detaillee ?? course;
  }

  /**
   * Bouton « Livreur a récupéré » de la caisse sur une commande d'une course
   * déjà récupérée, livreur encore au restaurant : quand plus rien n'est à
   * remettre, le livreur est prévenu qu'il peut partir.
   */
  async surRemiseParCaisse(courseId: string, commande: { id: string; reference?: string | null }): Promise<void> {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: {
        id: true,
        reference: true,
        restaurant_id: true,
        deliverer_id: true,
        statut: true,
        parti_at: true,
        deliveries: { select: { statut: true, order: { select: { status: true } } } },
      },
    });
    if (!course || course.statut !== CourseStatut.IN_DELIVERY || course.parti_at) return;
    await this.journal.ecrire({
      type: 'RETRAIT_COMPLEMENTAIRE',
      source: 'caisse',
      restaurant_id: course.restaurant_id,
      course_id: course.id,
      deliverer_id: course.deliverer_id,
      order_id: commande.id,
      details: { course: course.reference, commandes: [commande.reference ?? commande.id] },
    });
    const resteAPrendre = course.deliveries.some(
      (d) => !STATUTS_LIVRAISON_TERMINEE.includes(d.statut) && d.order.status === OrderStatus.READY,
    );
    if (!resteAPrendre) await this.annoncerToutRecupere(course.id);
  }

  /** `course:statut:changed` (livreur, restaurant, siège) et « Tout est récupéré » au livreur. */
  private async annoncerToutRecupere(courseId: string): Promise<CourseDetaillee | null> {
    const detaillee = await this.prisma.course.findUnique({ where: { id: courseId }, include: COURSE_FULL_INCLUDE });
    if (!detaillee) return null;
    await this.courseEvent.courseStatutChanged({
      course: detaillee,
      previous_statut: CourseStatut.IN_DELIVERY,
      new_statut: CourseStatut.IN_DELIVERY,
      reason: RaisonsPlanificateur.RETRAIT_COMPLEMENTAIRE,
    });
    if (detaillee.deliverer_id) {
      const texte = texteCommandeRemise();
      this.push.notifyCommandeRemise({
        delivererId: detaillee.deliverer_id,
        courseId,
        titre: texte.titre,
        corps: texte.corps,
      });
    }
    return detaillee;
  }
}
