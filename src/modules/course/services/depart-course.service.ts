import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CourseStatut, Delivery, DeliveryStatut, OrderStatus, Prisma } from '@prisma/client';

import { PrismaService } from 'src/database/services/prisma.service';
import type { DelivererLocationUpdatedPayload } from 'src/modules/deliverers/events/deliverer.event';
import { DelivererPushService } from 'src/modules/deliverers/services/deliverer-push.service';
import { NotificationsSenderService } from 'src/modules/notifications/services/notifications-sender.service';

import { CourseEvent } from '../events/course.event';
import {
  RaisonsPlanificateur,
  retenueEnCours,
  texteCommandeRemise,
  texteCommandeRetiree,
  texteRetenue,
  texteSacOublie,
} from '../helpers/application-plan.rules';
import { CourseSettingsHelper } from '../helpers/course-settings.helper';
import { COURSE_FULL_INCLUDE } from '../helpers/course.includes';
import {
  ajoutPasEncoreRemis,
  livraisonADemarrerAuDepart,
  motifFermetureALaValidation,
  MotifDepartDirect,
  MESSAGE_DEPART_AVANT_RETRAIT,
  MESSAGE_LIVREUR_PARTI,
  MESSAGE_RIEN_A_REMETTRE,
  MESSAGE_COURSE_PAS_A_TOI,
  sortiDuRestaurant,
} from '../helpers/depart.rules';
import { recalculerFraisCourse } from '../helpers/frais-course';
import { haversineMeters } from '../helpers/geo.helper';
import { planificateurDuRestaurant } from '../helpers/planification.rules';
import { STATUTS_LIVRAISON_TERMINEE } from '../helpers/remise-course.rules';
import { CourseGroupingService } from './course-grouping.service';
import { DispatchJournalService, SourceDispatch } from './dispatch-journal.service';

type CourseDetaillee = Prisma.CourseGetPayload<{ include: typeof COURSE_FULL_INCLUDE }>;

/** Le départ est déjà enregistré (autre chemin, autre serveur) : rien à faire. */
class DepartDejaEnregistre extends Error {}

/** Livraison d'une commande ajoutée après le retrait, pas remise : retirée au départ. */
const whereAjoutNonRemis = (courseId: string): Prisma.DeliveryWhereInput => ({
  course_id: courseId,
  statut: DeliveryStatut.PENDING,
  ajoutee_apres_retrait: true,
  order: { status: OrderStatus.READY },
});

export interface ResultatDepart {
  /** Vrai si CET appel a enregistré le départ (un seul gagnant, même à deux serveurs). */
  parti: boolean;
  /** Commandes ajoutées après le retrait et pas remises, retirées de la course. */
  detachees: { order_id: string; reference: string }[];
  /** Livraison démarrée par le serveur (nouvelle appli), sinon `null`. */
  demarree: string | null;
}

const AUCUN_DEPART: ResultatDepart = { parti: false, detachees: [], demarree: null };

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
 *  - DÉPART DÉDUIT, sans rien demander au livreur (demande du 23/10) :
 *    position reçue hors du rayon de départ (`surPosition`, tout de suite),
 *    première livraison démarrée (`avantDemarrageLivraison`), et, au passage
 *    du planificateur, fenêtre écoulée ou première livraison arrivée ;
 *  - BOUTON « Je pars » de la nouvelle appli (`POST /courses/deliverer/:id/depart`),
 *    facultatif ;
 *  - AU DÉPART (`enregistrerDepart`, une seule transaction) : `parti_at`
 *    posé sous condition, retenue levée, commandes ajoutées pas remises
 *    retirées de la course (repartent dans une autre), puis la première
 *    livraison dont la commande est remise est démarrée par le serveur pour
 *    la nouvelle appli (elle ne la démarre plus seule avant le départ) ;
 *  - RETRAIT COMPLÉMENTAIRE : la caisse saisit le même code, seules les
 *    commandes prêtes sont remises, la course reste en livraison, la tournée
 *    est réestimée, le livreur est prévenu (« Tout est récupéré »).
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
    // Restaurant en v1 : une commande retirée au départ repart dans un lot.
    private readonly regroupement?: CourseGroupingService,
    // Cloche du restaurant et du siège : départ avec une commande pas remise.
    private readonly cloche?: NotificationsSenderService,
  ) {}

  /**
   * Juste après la validation du retrait (code, bouton de la caisse, route du
   * livreur) : ferme la fenêtre d'ajout si elle ne doit pas s'ouvrir.
   *
   * @returns vrai si `parti_at` a été posé.
   */
  async fermerFenetreALaValidation(
    courseId: string,
    maintenant = new Date(),
    options: { annoncer?: boolean } = {},
  ): Promise<boolean> {
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
      data: { parti_at: maintenant, motif_depart: motif },
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
    // Nouvelle appli dont la fenêtre est fermée (réglage coupé, v1) : partie
    // tout de suite, sa première livraison démarre comme à tout départ.
    if (count === 1) {
      await this.demarrerPremiereLivraison(courseId, maintenant).catch(() => null);
      // L'événement de la validation est parti AVANT ce départ (bouton de la
      // caisse, route du livreur) : l'appli resterait sur l'écran du comptoir
      // jusqu'à sa relecture. Elle reçoit la course partie, première livraison
      // démarrée. La validation par le code annonce elle-même la course relue.
      if (options.annoncer !== false) await this.annoncerDepart(courseId);
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
   * Bouton « Je pars » du livreur (facultatif : le départ se déduit aussi de
   * la position et du démarrage de la première livraison). Idempotent : une
   * course déjà partie rend simplement la course. Une commande ajoutée après
   * le retrait et pas encore remise est retirée de la course tout de suite
   * (elle repart dans une autre) ; la retenue éventuelle est levée.
   */
  async jePars(courseId: string, delivererId: string, maintenant = new Date()): Promise<CourseDetaillee> {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: { id: true, deliverer_id: true, statut: true },
    });
    if (!course) throw new NotFoundException('Course non trouvée');
    if (course.deliverer_id !== delivererId) throw new ForbiddenException(MESSAGE_COURSE_PAS_A_TOI);
    if (course.statut !== CourseStatut.IN_DELIVERY) throw new BadRequestException(MESSAGE_DEPART_AVANT_RETRAIT);

    await this.enregistrerDepart(courseId, { motif: 'BOUTON', source: 'appli', maintenant });
    return this.prisma.course.findUniqueOrThrow({ where: { id: courseId }, include: COURSE_FULL_INCLUDE });
  }

  /**
   * DÉPART DU RESTAURANT, quel qu'en soit le signal (bouton, position,
   * première livraison démarrée). Une seule transaction, conditionnée :
   * `parti_at` posé si la course est encore en livraison et pas partie (un
   * seul gagnant), retenue levée, commandes ajoutées après le retrait et pas
   * remises RETIRÉES de la course. Un ajout du planificateur en cours sur la
   * même course passe avant ou après, jamais à moitié : la ligne de la course
   * est verrouillée par sa mise à jour conditionnelle (et un ajout arrivé
   * malgré tout après le départ est retiré au passage suivant).
   *
   * Ensuite : journal, première livraison démarrée pour la nouvelle appli
   * (sauf `demarrer: false`, quand l'appelant démarre la sienne),
   * `course:statut:changed` (raison DEPART), « Commande retirée » au livreur
   * s'il en part une, et les commandes retirées replanifiées (planificateur
   * en v2, lots en v1).
   */
  async enregistrerDepart(
    courseId: string,
    p: {
      motif: MotifDepartDirect;
      source: SourceDispatch;
      maintenant?: Date;
      demarrer?: boolean;
      details?: Record<string, unknown>;
    },
  ): Promise<ResultatDepart> {
    const maintenant = p.maintenant ?? new Date();
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: { id: true, reference: true, restaurant_id: true, deliverer_id: true, statut: true, parti_at: true },
    });
    if (!course || course.statut !== CourseStatut.IN_DELIVERY || course.parti_at) return AUCUN_DEPART;

    let detachees: ResultatDepart['detachees'] = [];
    try {
      detachees = await this.prisma.$transaction(async (tx) => {
        const partie = await tx.course.updateMany({
          where: { id: courseId, statut: CourseStatut.IN_DELIVERY, parti_at: null },
          data: { parti_at: maintenant, motif_depart: p.motif },
        });
        if (partie.count !== 1) throw new DepartDejaEnregistre();
        await tx.course.updateMany({
          where: { id: courseId, retenue_jusqua: { gt: maintenant } },
          data: { retenue_jusqua: maintenant, commandes_attendues: [] },
        });
        const aRetirer = await tx.delivery.findMany({
          where: whereAjoutNonRemis(courseId),
          select: { id: true, order: { select: { id: true, reference: true } } },
        });
        const retirees: ResultatDepart['detachees'] = [];
        for (const l of aRetirer) {
          const { count } = await tx.delivery.deleteMany({ where: { id: l.id, ...whereAjoutNonRemis(courseId) } });
          if (count === 1) retirees.push({ order_id: l.order.id, reference: l.order.reference });
        }
        return retirees;
      });
    } catch (err) {
      if (err instanceof DepartDejaEnregistre) return AUCUN_DEPART;
      throw err;
    }

    await this.journal.ecrire({
      type: 'COURSE_PARTIE',
      motif: p.motif,
      source: p.source,
      restaurant_id: course.restaurant_id,
      course_id: course.id,
      deliverer_id: course.deliverer_id,
      details: { course: course.reference, ...p.details },
    });
    if (detachees.length > 0) {
      await recalculerFraisCourse(this.prisma, courseId).catch(() => undefined);
      for (const d of detachees) {
        await this.journal.ecrire({
          type: 'COMMANDE_DETACHEE',
          motif: 'LIVREUR_PARTI',
          source: p.source,
          restaurant_id: course.restaurant_id,
          course_id: course.id,
          deliverer_id: course.deliverer_id,
          order_id: d.order_id,
          details: { commande: d.reference, libelle: `${d.reference} pas remise : repart seule` },
        });
      }
    }

    const demarree = p.demarrer === false ? null : await this.demarrerPremiereLivraison(courseId, maintenant).catch(() => null);
    await this.signalerCommandesPasRemises(courseId, p.motif, p.source).catch(() => []);

    const detaillee = await this.prisma.course.findUnique({ where: { id: courseId }, include: COURSE_FULL_INCLUDE });
    if (detaillee) {
      await this.courseEvent.courseStatutChanged({
        course: detaillee,
        previous_statut: CourseStatut.IN_DELIVERY,
        new_statut: CourseStatut.IN_DELIVERY,
        reason: RaisonsPlanificateur.DEPART,
      });
      if (detachees.length > 0 && detaillee.deliverer_id) {
        const restantes = detaillee.deliveries.filter((d) => !STATUTS_LIVRAISON_TERMINEE.includes(d.statut)).length;
        const texte = texteCommandeRetiree({ reference: detachees[0].reference, restantes });
        this.push.notifyCommandeRetiree({
          delivererId: detaillee.deliverer_id,
          courseId,
          titre: texte.titre,
          corps: texte.corps,
          commande: detachees.map((d) => d.reference).join(', '),
          restantes,
        });
      }
    }

    await this.replanifier(course.restaurant_id, detachees, `DEPART_${p.motif}`);
    this.logger.log(
      `Course ${course.reference} partie (${p.motif})${detachees.length ? `, retirée(s) : ${detachees.map((d) => d.reference).join(', ')}` : ''}.`,
    );
    return { parti: true, detachees, demarree };
  }

  /**
   * POSITION D'UN LIVREUR (écouteur de `deliverer:location:updated`) : sa
   * course récupérée n'est pas partie et la position, reçue après le
   * retrait, est hors du rayon de départ : le départ est enregistré tout de
   * suite (sans attendre le passage du planificateur, qui ne voit que la
   * dernière position).
   *
   * @returns le restaurant de la course concernée (pour un passage du
   *   planificateur) et si le départ vient d'être enregistré ; `null` si le
   *   livreur n'a pas de course récupérée encore au restaurant.
   */
  async surPosition(
    payload: Pick<DelivererLocationUpdatedPayload, 'delivererId' | 'lat' | 'lng' | 'ts' | 'accuracyM'>,
  ): Promise<{ restaurant_id: string; parti: boolean } | null> {
    const course = await this.prisma.course.findFirst({
      where: { deliverer_id: payload.delivererId, statut: CourseStatut.IN_DELIVERY, parti_at: null },
      select: {
        id: true,
        restaurant_id: true,
        picked_up_at: true,
        restaurant: { select: { latitude: true, longitude: true } },
      },
    });
    if (!course) return null;

    const lue = await this.settings.lirePlanification();
    const position = { lat: payload.lat, lng: payload.lng };
    const recueA = payload.ts ? new Date(payload.ts) : new Date();
    const restaurant =
      typeof course.restaurant?.latitude === 'number' && typeof course.restaurant?.longitude === 'number'
        ? { lat: course.restaurant.latitude, lng: course.restaurant.longitude }
        : null;
    const sorti = sortiDuRestaurant({
      position,
      position_at: Number.isNaN(recueA.getTime()) ? new Date() : recueA,
      restaurant,
      picked_up_at: course.picked_up_at,
      departRayonM: lue.planification.reglages.departRayonM,
      precision_m: payload.accuracyM ?? null,
    });
    if (!sorti || !restaurant) return { restaurant_id: course.restaurant_id, parti: false };

    const r = await this.enregistrerDepart(course.id, {
      motif: 'POSITION',
      source: 'serveur',
      details: { distance_m: Math.round(haversineMeters(position, restaurant)) },
    });
    return { restaurant_id: course.restaurant_id, parti: r.parti };
  }

  /**
   * Avant qu'un livreur démarre une livraison (`PATCH .../deliveries/:id/start`) :
   *  - une commande ajoutée après le retrait et pas encore remise ne se
   *    démarre pas (409 « Commande pas encore remise. ») : le livreur
   *    partirait sans le plat ;
   *  - course pas encore partie : démarrer une livraison, c'est quitter le
   *    restaurant. Le départ est enregistré avant le démarrage (les ajouts
   *    pas remis sont retirés, aucun ajout ne peut plus suivre).
   */
  async avantDemarrageLivraison(
    livraison: {
      course_id: string;
      statut: DeliveryStatut;
      ajoutee_apres_retrait: boolean;
      order: { status: OrderStatus };
      course: { parti_at: Date | null };
    },
    maintenant = new Date(),
  ): Promise<void> {
    if (ajoutPasEncoreRemis(livraison)) throw new ConflictException(MESSAGE_DEPART_AVANT_RETRAIT);
    if (livraison.course.parti_at) return;
    await this.enregistrerDepart(livraison.course_id, {
      motif: 'LIVRAISON_DEMARREE',
      source: 'appli',
      maintenant,
      demarrer: false,
    });
  }

  /**
   * Au départ, pour la nouvelle appli (protocole 3, qui ne démarre plus seule
   * la première livraison avant le départ) : la première livraison de la
   * tournée dont la commande est remise passe « en route », comme si le
   * livreur l'avait démarrée (client prévenu, heure d'arrivée). Écriture
   * conditionnée : rien si une livraison est déjà commencée, ou si l'appli
   * l'a démarrée au même instant.
   *
   * @returns l'identifiant de la livraison démarrée, sinon `null`.
   */
  async demarrerPremiereLivraison(courseId: string, maintenant = new Date()): Promise<string | null> {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: {
        id: true,
        reference: true,
        restaurant_id: true,
        statut: true,
        parti_at: true,
        deliverer: { select: { protocole_appli: true } },
        deliveries: {
          select: {
            id: true,
            statut: true,
            sequence_order: true,
            ajoutee_apres_retrait: true,
            order: { select: { status: true } },
          },
        },
      },
    });
    if (!course || course.statut !== CourseStatut.IN_DELIVERY || !course.parti_at) return null;
    const id = livraisonADemarrerAuDepart(course.deliveries, course.deliverer?.protocole_appli ?? null);
    if (!id) return null;

    const { count } = await this.prisma.delivery.updateMany({
      where: {
        id,
        statut: DeliveryStatut.PENDING,
        course: {
          statut: CourseStatut.IN_DELIVERY,
          deliveries: { none: { statut: { notIn: [DeliveryStatut.PENDING, DeliveryStatut.CANCELLED] } } },
        },
      },
      data: { statut: DeliveryStatut.IN_ROUTE, in_route_at: maintenant },
    });
    if (count !== 1) return null;

    // Le livreur ne lit jamais le code du client (comme la route du livreur).
    const livraison = await this.prisma.delivery.findUnique({ where: { id }, omit: { delivery_pin: true } });
    if (livraison) {
      await this.courseEvent.deliveryStatutChanged({
        delivery: livraison as unknown as Delivery,
        course_id: courseId,
        course_reference: course.reference,
        restaurant_id: course.restaurant_id,
        previous_statut: DeliveryStatut.PENDING,
        new_statut: DeliveryStatut.IN_ROUTE,
      });
    }
    return id;
  }

  /**
   * Après un départ réel (position, livraison démarrée, « Je pars », fenêtre
   * écoulée) : une commande de la course d'origine encore prête au comptoir
   * (remise commande par commande au bouton de la caisse, la suivante jamais
   * remise) part sans son sac. Rien ne la retire de la course (la caissière
   * l'a peut-être donnée sans toucher le bouton) : le journal la note, le
   * restaurant et le siège sont prévenus par la cloche, et le livreur par
   * « Sac oublié » (notification `sac_oublie`), au lieu du silence.
   * Les commandes ajoutées après le retrait, elles, sont déjà détachées.
   *
   * @returns les références signalées.
   */
  async signalerCommandesPasRemises(courseId: string, motif: string, source: SourceDispatch = 'serveur'): Promise<string[]> {
    const course = await this.prisma.course.findUnique({
      where: { id: courseId },
      select: {
        id: true,
        reference: true,
        restaurant_id: true,
        deliverer_id: true,
        deliveries: {
          // Une commande ajoutée après le retrait et pas remise est détachée au départ (repart seule) : rien à signaler.
          where: { statut: { notIn: STATUTS_LIVRAISON_TERMINEE }, ajoutee_apres_retrait: false, order: { status: OrderStatus.READY } },
          select: { order: { select: { id: true, reference: true } } },
        },
      },
    });
    if (!course || course.deliveries.length === 0) return [];
    const references = course.deliveries.map((d) => d.order.reference);
    await this.journal.ecrire({
      type: 'DEPART_SANS_COMMANDE',
      motif,
      source,
      restaurant_id: course.restaurant_id,
      course_id: course.id,
      deliverer_id: course.deliverer_id,
      details: { course: course.reference, commandes: references },
    });
    this.logger.warn(`Course ${course.reference} partie sans ${references.join(', ')} (encore au comptoir).`);
    void this.cloche
      ?.sendCommandePasRemiseBell({
        courseId: course.id,
        reference: course.reference,
        restaurantId: course.restaurant_id,
        commandes: references,
      })
      .catch(() => undefined);
    // Le livreur aussi, tout de suite : sinon il roulait sans savoir qu'un sac
    // manquait, puis restait bloqué sur cette commande (relecture du 24/10).
    if (course.deliverer_id) {
      const texte = texteSacOublie({ sacs: references.length });
      this.push.notifySacOublie({
        delivererId: course.deliverer_id,
        courseId: course.id,
        titre: texte.titre,
        corps: texte.corps,
        commandes: references,
      });
    }
    return references;
  }

  /** Commandes retirées au départ : planificateur (v2) ou lots (v1). */
  private async replanifier(
    restaurantId: string,
    detachees: ResultatDepart['detachees'],
    raison: string,
  ): Promise<void> {
    const version = await this.settings.versionPour(restaurantId).catch(() => 'v2' as const);
    if (version === 'v1') {
      for (const d of detachees) {
        await this.regroupement?.tryGroupOrder(d.order_id).catch((err) =>
          this.logger.warn(`Commande ${d.reference} retirée non regroupée : ${(err as Error)?.message}`),
        );
      }
      return;
    }
    this.courseEvent.demanderPlanification({ restaurant_id: restaurantId, raison });
  }

  /**
   * RETRAIT COMPLÉMENTAIRE par le code de retrait : course récupérée, livreur
   * encore au restaurant. Seules les commandes prêtes sont remises (les déjà
   * remises sont ignorées) ; la course reste en livraison. Écriture
   * conditionnée : si le livreur vient de partir, ses commandes AJOUTÉES pas
   * remises sont détachées (elles repartent seules) : 409 et rien n'est remis.
   * Deux caisses qui saisissent le même code au même instant : la ligne de
   * la course, verrouillée par la première, fait attendre la seconde, qui ne
   * trouve plus rien de prêt et reçoit 409 ; le livreur n'est prévenu qu'une
   * fois.
   *
   * SAC OUBLIÉ (relecture du 24/10) : le livreur est parti sans une commande
   * d'ORIGINE encore prête (remise une par une au bouton de la caisse), puis
   * revient la chercher et montre le même code (écran « Sac au restaurant »
   * de l'appli) : elle lui est remise, sa livraison démarre dans l'appli.
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

    const { remises, apresDepart } = await this.prisma.$transaction(async (tx) => {
      const encore = await tx.course.updateMany({
        where: { id: course.id, statut: CourseStatut.IN_DELIVERY },
        data: { updated_at: maintenant },
      });
      if (encore.count !== 1) throw new ConflictException(MESSAGE_LIVREUR_PARTI);
      // Relu sous le verrou de la ligne : un départ enregistré au même instant
      // a déjà détaché les commandes ajoutées pas remises.
      const etat = await tx.course.findUnique({ where: { id: course.id }, select: { parti_at: true } });
      const partie = !!etat?.parti_at;
      // Relues sous le verrou de la ligne : une autre caisse (ou le bouton
      // « Livreur a récupéré ») a pu les remettre entre-temps. Après le
      // départ, seules les commandes d'origine restent à remettre.
      const pretes = await tx.order.findMany({
        where: {
          id: { in: aRemettre.map((d) => d.order.id) },
          status: OrderStatus.READY,
          delivery: { course_id: course.id, ...(partie ? { ajoutee_apres_retrait: false } : {}) },
        },
        select: { id: true, reference: true },
      });
      if (pretes.length === 0) {
        const originales = aRemettre.some((d) => !d.ajoutee_apres_retrait);
        throw new ConflictException(partie && !originales ? MESSAGE_LIVREUR_PARTI : MESSAGE_RIEN_A_REMETTRE);
      }
      const { count } = await tx.order.updateMany({
        where: { id: { in: pretes.map((o) => o.id) }, status: OrderStatus.READY },
        data: { status: OrderStatus.PICKED_UP, picked_up_at: maintenant },
      });
      if (count === 0) throw new ConflictException(MESSAGE_RIEN_A_REMETTRE);
      return { remises: pretes, apresDepart: partie };
    });

    const references = remises.map((o) => o.reference);
    await this.journal.ecrire({
      type: 'RETRAIT_COMPLEMENTAIRE',
      source,
      restaurant_id: course.restaurant_id,
      course_id: course.id,
      deliverer_id: course.deliverer_id,
      details: { course: course.reference, commandes: references, ...(apresDepart ? { apres_depart: true } : {}) },
    });
    const detaillee = await this.annoncerToutRecupere(course.id, maintenant);
    this.logger.log(
      `Course ${course.reference} : retrait complémentaire (${references.join(', ')}), même code${apresDepart ? ', après le départ' : ''}.`,
    );
    return detaillee ?? course;
  }

  /**
   * Bouton « Livreur a récupéré » de la caisse sur une commande d'une course
   * déjà récupérée :
   *  - quand plus rien n'est à remettre, le livreur est prévenu qu'il peut
   *    partir (« Tout est récupéré ») ;
   *  - sinon, la course relue lui part tout de suite (sac pris coché dans
   *    l'appli, sans attendre sa relecture) ;
   *  - y compris APRÈS SON DÉPART (relecture du 24/10) : il était parti sans
   *    ce sac (« Sac oublié »), revenu le chercher ; sa livraison démarre dans
   *    l'appli dès la course relue, au lieu d'attendre 15 s. Restaurant en
   *    v1 : rien, exactement comme avant.
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
    if (!course || course.statut !== CourseStatut.IN_DELIVERY) return;
    if (course.parti_at && (await this.settings.versionPour(course.restaurant_id)) === 'v1') return;
    await this.journal.ecrire({
      type: 'RETRAIT_COMPLEMENTAIRE',
      source: 'caisse',
      restaurant_id: course.restaurant_id,
      course_id: course.id,
      deliverer_id: course.deliverer_id,
      order_id: commande.id,
      details: {
        course: course.reference,
        commandes: [commande.reference ?? commande.id],
        ...(course.parti_at ? { apres_depart: true } : {}),
      },
    });
    const resteAPrendre = course.deliveries.some(
      (d) => !STATUTS_LIVRAISON_TERMINEE.includes(d.statut) && d.order.status === OrderStatus.READY,
    );
    if (!resteAPrendre) await this.annoncerToutRecupere(course.id);
    else await this.annoncerCourse(course.id, RaisonsPlanificateur.RETRAIT_COMPLEMENTAIRE);
  }

  /** `course:statut:changed` raison DEPART (livreur, restaurant, siège). */
  private async annoncerDepart(courseId: string): Promise<void> {
    await this.annoncerCourse(courseId, RaisonsPlanificateur.DEPART);
  }

  /** `course:statut:changed` de la course relue, en livraison (livreur, restaurant, siège). */
  private async annoncerCourse(courseId: string, reason: string): Promise<void> {
    const detaillee = await this.prisma.course.findUnique({ where: { id: courseId }, include: COURSE_FULL_INCLUDE });
    if (!detaillee) return;
    await this.courseEvent.courseStatutChanged({
      course: detaillee,
      previous_statut: CourseStatut.IN_DELIVERY,
      new_statut: CourseStatut.IN_DELIVERY,
      reason,
    });
  }

  /**
   * `course:statut:changed` (livreur, restaurant, siège) et « Tout est
   * récupéré » au livreur. Retenue encore en cours pour une autre commande
   * (livreur pas parti) : « Attends 4 min / Départ 12 h 34 », jamais « Tu
   * peux partir » (essai du 25/10).
   */
  private async annoncerToutRecupere(courseId: string, maintenant = new Date()): Promise<CourseDetaillee | null> {
    const detaillee = await this.prisma.course.findUnique({ where: { id: courseId }, include: COURSE_FULL_INCLUDE });
    if (!detaillee) return null;
    await this.courseEvent.courseStatutChanged({
      course: detaillee,
      previous_statut: CourseStatut.IN_DELIVERY,
      new_statut: CourseStatut.IN_DELIVERY,
      reason: RaisonsPlanificateur.RETRAIT_COMPLEMENTAIRE,
    });
    const retenue = detaillee.parti_at ? null : retenueEnCours(detaillee, maintenant);
    if (detaillee.deliverer_id && retenue) {
      const texte = texteRetenue({ jusqua: retenue.jusqua, maintenant });
      this.push.notifyCourseAttente({
        delivererId: detaillee.deliverer_id,
        courseId,
        titre: texte.titre,
        corps: texte.corps,
        jusqua: retenue.jusqua,
        attendues: retenue.attendues,
      });
    } else if (detaillee.deliverer_id) {
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
