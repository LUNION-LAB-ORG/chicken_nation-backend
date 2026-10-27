import { Injectable, Logger } from '@nestjs/common';
import {
  CourseOfferStatus,
  CourseStatut,
  DeliveryService,
  DeliveryStatut,
  EntityStatus,
  OrderStatus,
  OrderType,
  Prisma,
} from '@prisma/client';

import { PrismaService } from 'src/database/services/prisma.service';
import { DelivererPushService } from 'src/modules/deliverers/services/deliverer-push.service';

import { CourseEvent } from '../events/course.event';
import {
  commandesAttenduesAEcrire,
  libelleRegroupement,
  liberationAAnnoncer,
  numeroterArrets,
  RaisonPlanificateur,
  RaisonsPlanificateur,
  texteCommandeAjoutee,
  texteCommandeRemise,
  texteCommandeRetiree,
  texteRetenue,
  texteToutEstPret,
} from '../helpers/application-plan.rules';
import { CourseHelper } from '../helpers/course.helper';
import { COURSE_FULL_INCLUDE } from '../helpers/course.includes';
import { estDepartReel } from '../helpers/depart.rules';
import { recalculerFraisCourse } from '../helpers/frais-course';
import {
  ActionAjouter,
  ActionAnnulerCourseVide,
  ActionConfierTurbo,
  ActionCreerCourse,
  ActionDetacher,
  ActionFusionner,
  ActionLiberer,
  ActionMarquerParti,
  ActionOffrir,
  ActionOrdonner,
  ActionPlanification,
  ActionReprendreOffre,
  ActionRetenir,
  MotifLiberation,
  PlanRestaurant,
  TypeActionPlanification,
} from '../helpers/planification.rules';
import { STATUTS_LIVRAISON_TERMINEE } from '../helpers/remise-course.rules';
import { CourseGroupingService } from './course-grouping.service';
import { CourseOfferService } from './course-offer.service';
import { DepartCourseService } from './depart-course.service';
import { DispatchJournalService } from './dispatch-journal.service';
import { ContexteInstantane, InstantaneLu } from './instantane-planification.service';
import { OffresClotureService } from './offres-cloture.service';

/** La course ou la commande a changé entre la lecture et l'écriture : l'action est abandonnée. */
export class ActionAbandonnee extends Error {
  constructor(readonly motif: string) {
    super(motif);
  }
}

/**
 * Turbo a refusé la course (ou était injoignable) : pas de nouvel essai avant
 * 2 min. Le passage de 10 s ne relance pas Turbo (et sa cloche) à chaque fois.
 */
const PAUSE_APRES_ECHEC_TURBO_MS = 2 * 60 * 1000;
const MOTIF_TURBO_PAS_AVANT = 'TURBO_PAS_AVANT';
/**
 * Turbo injoignable : le passage n'attend pas sa réponse plus de 15 s (le
 * restaurant suivant attend son tour, le verrou est tenu). L'envoi continue
 * en arrière-plan et son issue est journalisée quand elle arrive ; la
 * réservation `turbo_escalated_at` empêche tout second envoi.
 */
export const DELAI_ENVOI_TURBO_MS = 15_000;


/** Statuts d'une course dont le livreur est affecté et pas parti. */
const STATUTS_AVEC_LIVREUR: CourseStatut[] = [CourseStatut.ACCEPTED, CourseStatut.AT_RESTAURANT, CourseStatut.IN_DELIVERY];

export interface OptionsApplication {
  /** `course.max_refusal_count` : au-delà, la course expire au lieu d'être proposée (comme aujourd'hui). */
  maxRefus: number;
  /** Retour à v1 : les commandes détachées repartent dans l'ancien regroupement par lots. */
  repliV1?: boolean;
  /**
   * Heure (ms) au-delà de laquelle plus aucune action n'est commencée : le
   * verrou du restaurant est tenu par une transaction bornée, rien ne doit
   * s'écrire après qu'il a été rendu. Les actions restantes sont abandonnées
   * (le passage suivant les recalcule).
   */
  echeanceMs?: number;
}

export interface ResultatApplication {
  appliquees: TypeActionPlanification[];
  abandonnees: { type: TypeActionPlanification; motif: string }[];
  /** Courses créées : clé du plan (`nouvelle-N`) vers identifiant. */
  creees: Map<string, string>;
}

/** État d'un passage : ce qui reste à annoncer une fois toutes les actions écrites. */
interface Passage extends Annonces {
  restaurantId: string;
  lu: InstantaneLu;
  options: OptionsApplication;
  cles: Map<string, string>;
}

/** Ce qu'un passage annonce une fois tout écrit (aussi un retrait fait hors du passage). */
interface Annonces {
  maintenant: Date;
  /** Courses modifiées sans changement de statut : `course:statut:changed` avec cette raison. */
  touchees: Map<string, RaisonPlanificateur>;
  /** Commandes ajoutées par course (ajouts et fusions). */
  ajouts: Map<string, { n: number; apresRetrait: boolean }>;
  /** Commandes retirées de la course (détachées au départ, passées à emporter), par course. */
  retirees: Map<string, string[]>;
  /** Première retenue posée sur la course dans ce passage (le livreur est prévenu). */
  retenues: Map<string, { jusqua: Date; attendues: string[] }>;
  /** Retenues levées dans ce passage, avec leur motif. */
  liberations: Map<string, MotifLiberation>;
  /** Références des courses absorbées, par course cible (fusions). */
  absorbees: Map<string, string[]>;
}

/**
 * Commande ajoutée ou fusionnée dans une course SANS livreur : la cloche
 * « aucun livreur » peut sonner de nouveau, pour elle (relecture du 25/10).
 * Sans cela, une course qui avait déjà sonné n'alertait plus personne.
 */
function rouvrirClocheSansLivreur(statut: CourseStatut): { no_deliverer_alerted_at?: null } {
  return statut === CourseStatut.PENDING_ASSIGNMENT ? { no_deliverer_alerted_at: null } : {};
}

/**
 * APPLICATION DU PLAN du planificateur v2 (planification.rules.ts) : chaque
 * action est écrite par une mise à jour CONDITIONNELLE (la course et la
 * commande doivent être encore telles que lues) ; si la condition échoue,
 * l'action est abandonnée et le passage suivant la recalcule. Chaque action
 * a sa ligne au journal de la diffusion, avec son motif.
 *
 * Après les écritures : `course:statut:changed` (livreur, restaurant, siège)
 * pour chaque course touchée, offre en attente renvoyée à jour (même
 * échéance) au livreur sollicité, notifications au livreur affecté.
 *
 * Jamais d'affectation sans acceptation : OFFRIR passe par `offerToDeliverer`
 * (règle unique relue sous le verrou du livreur) et le livreur accepte.
 */
@Injectable()
export class ApplicationPlanService {
  private readonly logger = new Logger('Dispatch');

  constructor(
    private readonly prisma: PrismaService,
    private readonly offres: CourseOfferService,
    private readonly helper: CourseHelper,
    private readonly courseEvent: CourseEvent,
    private readonly push: DelivererPushService,
    private readonly journal: DispatchJournalService,
    private readonly cloture: OffresClotureService,
    private readonly regroupement: CourseGroupingService,
    // Au départ, la première livraison de la nouvelle appli est démarrée par le serveur.
    private readonly depart?: DepartCourseService,
  ) {}

  async appliquer(plan: PlanRestaurant, lu: InstantaneLu, options: OptionsApplication): Promise<ResultatApplication> {
    const passage: Passage = {
      restaurantId: plan.restaurant_id,
      maintenant: plan.maintenant,
      lu,
      options,
      cles: new Map(),
      touchees: new Map(),
      ajouts: new Map(),
      retirees: new Map(),
      retenues: new Map(),
      liberations: new Map(),
      absorbees: new Map(),
    };
    const resultat: ResultatApplication = { appliquees: [], abandonnees: [], creees: passage.cles };

    for (const action of plan.actions) {
      if (options.echeanceMs !== undefined && Date.now() > options.echeanceMs) {
        resultat.abandonnees.push({ type: action.type, motif: 'PASSAGE_TROP_LONG' });
        continue;
      }
      try {
        await this.appliquerUne(action, passage);
        resultat.appliquees.push(action.type);
      } catch (err) {
        const motif = err instanceof ActionAbandonnee ? err.motif : `ERREUR: ${(err as Error)?.message ?? err}`;
        resultat.abandonnees.push({ type: action.type, motif });
        if (!(err instanceof ActionAbandonnee)) {
          this.logger.error(`Action ${action.type} en échec : ${(err as Error)?.message ?? err}`);
        }
        if (motif === MOTIF_TURBO_PAS_AVANT) continue; // attente normale, rien à journaliser
        await this.journal.ecrire({
          type: 'ACTION_ABANDONNEE',
          motif: action.type,
          source: 'serveur',
          restaurant_id: passage.restaurantId,
          course_id: 'course_id' in action ? action.course_id : 'cible_id' in action ? action.cible_id : null,
          details: { raison: motif.slice(0, 200) },
        });
      }
    }

    await this.annoncer(passage);
    return resultat;
  }

  private appliquerUne(a: ActionPlanification, p: Passage): Promise<void> {
    switch (a.type) {
      case 'ANNULER_COURSE_VIDE':
        return this.annulerCourseVide(a, p);
      case 'MARQUER_PARTI':
        return this.marquerParti(a, p);
      case 'DETACHER':
        return this.detacher(a, p);
      case 'AJOUTER':
        return this.ajouter(a, p);
      case 'CREER_COURSE':
        return this.creerCourse(a, p);
      case 'FUSIONNER':
        return this.fusionner(a, p);
      case 'ORDONNER':
        return this.ordonner(a, p);
      case 'OFFRIR':
        return this.offrir(a, p);
      case 'REPRENDRE_OFFRE':
        return this.reprendreOffre(a, p);
      case 'RETENIR':
        return this.retenir(a, p);
      case 'LIBERER':
        return this.liberer(a, p);
      case 'CONFIER_TURBO':
        return this.confierTurbo(a, p);
    }
  }

  // ─── Course vide ───────────────────────────────────────────────────────────

  /**
   * Course sans livreur dont toutes les commandes ont été annulées : annulée
   * par le système, sous condition (toujours sans livreur, pas chez Turbo,
   * au moins une livraison et aucune encore à livrer). Une acceptation ou une
   * commande rattachée au même instant l'emporte : l'action est abandonnée.
   * Les commandes ne sont pas touchées ; l'offre en attente est close sans
   * pénalité ; siège et restaurant sont prévenus (`course:cancelled`).
   */
  private async annulerCourseVide(a: ActionAnnulerCourseVide, p: Passage): Promise<void> {
    const now = p.maintenant;
    const { count } = await this.prisma.course.updateMany({
      where: {
        id: a.course_id,
        statut: CourseStatut.PENDING_ASSIGNMENT,
        deliverer_id: null,
        turbo_escalated_at: null,
        deliveries: {
          some: {},
          none: { statut: { notIn: STATUTS_LIVRAISON_TERMINEE }, order: { status: { not: OrderStatus.CANCELLED } } },
        },
      },
      data: {
        statut: CourseStatut.CANCELLED,
        cancelled_at: now,
        cancelled_by: 'system',
        cancelled_reason: 'Plus aucune commande à livrer : toutes ses commandes ont été annulées',
        offer_expires_at: null,
      },
    });
    if (count !== 1) throw new ActionAbandonnee('COURSE_CHANGEE');
    await this.prisma.delivery.updateMany({
      where: { course_id: a.course_id, statut: { notIn: STATUTS_LIVRAISON_TERMINEE } },
      data: { statut: DeliveryStatut.CANCELLED },
    });
    await this.cloture
      .clorePourCourse(a.course_id, 'COURSE_ANNULEE', { relancerRecherche: false, maintenant: now })
      .catch((err) => this.logger.warn(`Offres de la course vide non closes : ${(err as Error)?.message}`));
    await recalculerFraisCourse(this.prisma, a.course_id).catch(() => undefined);
    await this.journal.ecrire({
      type: 'COURSE_VIDE_ANNULEE',
      source: 'serveur',
      restaurant_id: p.restaurantId,
      course_id: a.course_id,
      details: { libelle: a.libelle, offre_close: !!a.offre },
    });
    const course = await this.prisma.course.findUnique({ where: { id: a.course_id }, include: COURSE_FULL_INCLUDE });
    if (course) {
      await this.courseEvent.courseCancelled({
        course,
        cancelled_by: 'system',
        reason: course.cancelled_reason ?? a.libelle,
      });
    }
  }

  // ─── Départs ───────────────────────────────────────────────────────────────

  private async marquerParti(a: ActionMarquerParti, p: Passage): Promise<void> {
    const { count } = await this.prisma.course.updateMany({
      where: { id: a.course_id, statut: CourseStatut.IN_DELIVERY, parti_at: null },
      data: { parti_at: p.maintenant, motif_depart: a.motif },
    });
    if (count !== 1) throw new ActionAbandonnee('COURSE_CHANGEE');
    p.touchees.set(a.course_id, RaisonsPlanificateur.DEPART);
    await this.journal.ecrire({
      type: 'COURSE_PARTIE',
      motif: a.motif,
      source: 'serveur',
      restaurant_id: p.restaurantId,
      course_id: a.course_id,
      deliverer_id: a.deliverer_id,
      details: { libelle: a.libelle },
    });
    await this.depart?.demarrerPremiereLivraison(a.course_id, p.maintenant).catch(() => null);
    // Départ réel (pas une fenêtre qui n'aurait jamais dû s'ouvrir) : une
    // commande d'origine pas remise est signalée au restaurant et au siège.
    if (estDepartReel(a.motif)) {
      await this.depart?.signalerCommandesPasRemises(a.course_id, a.motif).catch(() => []);
    }
  }

  private async detacher(a: ActionDetacher, p: Passage): Promise<void> {
    const { count } = await this.prisma.delivery.deleteMany({
      where: {
        course_id: a.course_id,
        order_id: a.order_id,
        statut: DeliveryStatut.PENDING,
        ajoutee_apres_retrait: true,
        order: { status: OrderStatus.READY },
      },
    });
    if (count !== 1) throw new ActionAbandonnee('LIVRAISON_CHANGEE');
    await recalculerFraisCourse(this.prisma, a.course_id).catch(() => undefined);
    p.touchees.set(a.course_id, RaisonsPlanificateur.COMMANDE_DETACHEE);
    p.retirees.set(a.course_id, [...(p.retirees.get(a.course_id) ?? []), a.reference]);
    await this.journal.ecrire({
      type: 'COMMANDE_DETACHEE',
      motif: a.motif,
      source: 'serveur',
      restaurant_id: p.restaurantId,
      course_id: a.course_id,
      order_id: a.order_id,
      details: { commande: a.reference, libelle: a.libelle },
    });
    // Retour à l'ancienne méthode : la commande repart dans un lot.
    if (p.options.repliV1) {
      await this.regroupement.tryGroupOrder(a.order_id).catch((err) =>
        this.logger.warn(`Commande ${a.reference} détachée non regroupée : ${(err as Error)?.message}`),
      );
    }
  }

  // ─── Ajouts, créations, fusions ───────────────────────────────────────────

  private async ajouter(a: ActionAjouter, p: Passage): Promise<void> {
    const now = p.maintenant;
    const motif = libelleRegroupement(a.motif);
    try {
      await this.prisma.$transaction(async (tx) => {
        // La course est encore telle que lue : même statut, même livreur, pas
        // chez Turbo, pas partie. Une acceptation au même instant l'emporte.
        const course = await tx.course.updateMany({
          where: {
            id: a.course_id,
            statut: a.statut_course,
            deliverer_id: a.deliverer_id,
            turbo_escalated_at: null,
            ...(a.statut_course === CourseStatut.IN_DELIVERY ? { parti_at: null } : {}),
          },
          data: {
            updated_at: now,
            ...(motif ? { motif_regroupement: motif } : {}),
            ...rouvrirClocheSansLivreur(a.statut_course),
          },
        });
        if (course.count !== 1) throw new ActionAbandonnee('COURSE_CHANGEE');
        const commande = await tx.order.findFirst({
          where: {
            id: a.order_id,
            restaurant_id: p.restaurantId,
            // Passée à emporter ou sur place depuis la lecture : plus rien à livrer.
            type: OrderType.DELIVERY,
            status: OrderStatus.READY,
            delivery: null,
            entity_status: { not: EntityStatus.DELETED },
          },
          select: { id: true, recovery_code: true },
        });
        if (!commande) throw new ActionAbandonnee('COMMANDE_CHANGEE');
        const max = await tx.delivery.aggregate({ where: { course_id: a.course_id }, _max: { sequence_order: true } });
        await tx.delivery.create({
          data: {
            course_id: a.course_id,
            order_id: a.order_id,
            sequence_order: (max._max.sequence_order ?? 0) + 1,
            delivery_pin: commande.recovery_code ?? this.helper.generateDeliveryPin(),
            statut: DeliveryStatut.PENDING,
            ajoutee_at: now,
            ajoutee_apres_retrait: a.apres_retrait,
          },
        });
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ActionAbandonnee('COMMANDE_DEJA_EN_COURSE');
      }
      throw err;
    }
    await this.reporterCodeClient(a.order_id);
    await recalculerFraisCourse(this.prisma, a.course_id).catch(() => undefined);
    this.noterAjout(p, a.course_id, 1, a.apres_retrait, RaisonsPlanificateur.COMMANDE_AJOUTEE);
    await this.journal.ecrire({
      type: 'COMMANDE_AJOUTEE',
      motif: a.motif ?? 'SEULE',
      source: 'serveur',
      restaurant_id: p.restaurantId,
      course_id: a.course_id,
      deliverer_id: a.deliverer_id,
      order_id: a.order_id,
      details: {
        commande: a.reference,
        libelle: a.libelle,
        detour_s: a.detour_s,
        apres_retrait: a.apres_retrait,
        attendue: a.attendue,
        statut_course: a.statut_course,
      },
    });
  }

  private async creerCourse(a: ActionCreerCourse, p: Passage): Promise<void> {
    const now = p.maintenant;
    let creee: { id: string; reference: string; commandes: string[] } | null = null;
    for (let essai = 0; essai < 3 && !creee; essai++) {
      try {
        creee = await this.prisma.$transaction(async (tx) => {
          const commandes = await tx.order.findMany({
            where: {
              id: { in: a.order_ids },
              restaurant_id: p.restaurantId,
              type: OrderType.DELIVERY,
              delivery_service: DeliveryService.CHICKEN_NATION,
              status: OrderStatus.READY,
              entity_status: { not: EntityStatus.DELETED },
              delivery: null,
            },
            select: { id: true, delivery_fee: true, recovery_code: true },
          });
          if (commandes.length === 0) throw new ActionAbandonnee('COMMANDES_CHANGEES');
          const parId = new Map(commandes.map((c) => [c.id, c]));
          const ordre = [...a.sequence, ...a.order_ids].filter((id, i, t) => parId.has(id) && t.indexOf(id) === i);

          // Code de retrait tiré sous le verrou du restaurant (unique dans la journée).
          const code = await this.helper.genererCodeRetrait(tx, p.restaurantId, now);
          const course = await tx.course.create({
            data: {
              reference: this.helper.generateReference(),
              pickup_code: code,
              restaurant_id: p.restaurantId,
              statut: CourseStatut.PENDING_ASSIGNMENT,
              total_delivery_fee: commandes.reduce((s, c) => s + (c.delivery_fee ?? 0), 0),
              motif_regroupement: ordre.length > 1 ? libelleRegroupement(a.motif) : null,
            },
            select: { id: true, reference: true },
          });
          for (const [i, id] of ordre.entries()) {
            const c = parId.get(id)!;
            await tx.delivery.create({
              data: {
                course_id: course.id,
                order_id: id,
                sequence_order: i + 1,
                // Le code du client vient de la commande (déjà sous ses yeux).
                delivery_pin: c.recovery_code ?? this.helper.generateDeliveryPin(),
                statut: DeliveryStatut.PENDING,
              },
            });
          }
          return { id: course.id, reference: course.reference, commandes: ordre };
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          const cible = String((err.meta as { target?: unknown } | undefined)?.target ?? '');
          if (cible.includes('reference')) continue;
          throw new ActionAbandonnee('COMMANDE_DEJA_EN_COURSE');
        }
        throw err;
      }
    }
    if (!creee) throw new ActionAbandonnee('REFERENCE_INDISPONIBLE');

    for (const id of creee.commandes) await this.reporterCodeClient(id);
    p.cles.set(a.cle, creee.id);
    p.touchees.set(creee.id, RaisonsPlanificateur.COURSE_CREEE);
    await this.journal.ecrire({
      type: 'COURSE_CREEE',
      motif: creee.commandes.length > 1 ? (a.motif ?? 'GROUPE') : 'SEULE',
      source: 'serveur',
      restaurant_id: p.restaurantId,
      course_id: creee.id,
      details: { course: creee.reference, commandes: creee.commandes.length, libelle: a.libelle },
    });
  }

  private async fusionner(a: ActionFusionner, p: Passage): Promise<void> {
    const now = p.maintenant;
    const motif = libelleRegroupement(a.motif);
    const refCible = p.lu.instantane.courses.find((k) => k.id === a.cible_id)?.reference ?? a.cible_id;
    await this.prisma.$transaction(async (tx) => {
      const cible = await tx.course.updateMany({
        where: {
          id: a.cible_id,
          statut: a.statut_cible,
          deliverer_id: a.deliverer_id,
          turbo_escalated_at: null,
          ...(a.statut_cible === CourseStatut.IN_DELIVERY ? { parti_at: null } : {}),
        },
        data: {
          updated_at: now,
          ...(motif ? { motif_regroupement: motif } : {}),
          ...rouvrirClocheSansLivreur(a.statut_cible),
        },
      });
      if (cible.count !== 1) throw new ActionAbandonnee('CIBLE_CHANGEE');

      // La course absorbée cherche encore un livreur, sans livreur, pas chez
      // Turbo : une acceptation au même instant l'emporte (et la fusion est
      // abandonnée), jamais l'inverse.
      const absorbee = await tx.course.updateMany({
        where: { id: a.absorbee_id, statut: CourseStatut.PENDING_ASSIGNMENT, deliverer_id: null, turbo_escalated_at: null },
        data: {
          statut: CourseStatut.CANCELLED,
          cancelled_at: now,
          cancelled_by: 'system',
          cancelled_reason: `Fusionnée automatiquement avec course ${refCible}`,
          offer_expires_at: null,
        },
      });
      if (absorbee.count !== 1) throw new ActionAbandonnee('COURSE_ABSORBEE_CHANGEE');

      const livraisons = await tx.delivery.findMany({
        where: { course_id: a.absorbee_id, statut: { notIn: STATUTS_LIVRAISON_TERMINEE } },
        select: { id: true, order_id: true, order: { select: { status: true } } },
        orderBy: { sequence_order: 'asc' },
      });
      const actives = livraisons.filter((l) => l.order.status !== OrderStatus.CANCELLED);
      const attendues = new Set(a.order_ids);
      if (actives.length !== attendues.size || actives.some((l) => !attendues.has(l.order_id))) {
        throw new ActionAbandonnee('COMMANDES_CHANGEES');
      }
      const max = await tx.delivery.aggregate({ where: { course_id: a.cible_id }, _max: { sequence_order: true } });
      for (const [i, l] of actives.entries()) {
        const deplacee = await tx.delivery.updateMany({
          where: { id: l.id, course_id: a.absorbee_id },
          data: {
            course_id: a.cible_id,
            sequence_order: (max._max.sequence_order ?? 0) + 1 + i,
            ajoutee_at: now,
            ajoutee_apres_retrait: a.apres_retrait,
          },
        });
        if (deplacee.count !== 1) throw new ActionAbandonnee('LIVRAISON_CHANGEE');
      }
      // Livraisons restées sur la course absorbée (commande annulée) : closes avec elle.
      await tx.delivery.updateMany({
        where: { course_id: a.absorbee_id, statut: { notIn: STATUTS_LIVRAISON_TERMINEE } },
        data: { statut: DeliveryStatut.CANCELLED },
      });
    });

    // Offre de la course absorbée close sans pénalité (l'appli la ferme).
    await this.cloture
      .clorePourCourse(a.absorbee_id, 'COURSE_FUSIONNEE', {
        relancerRecherche: false,
        details: { fusionnee_dans: a.cible_id },
        maintenant: now,
      })
      .catch((err) => this.logger.warn(`Offres de la course absorbée non closes : ${(err as Error)?.message}`));
    await recalculerFraisCourse(this.prisma, a.cible_id).catch(() => undefined);
    await recalculerFraisCourse(this.prisma, a.absorbee_id).catch(() => undefined);

    this.noterAjout(p, a.cible_id, a.order_ids.length, a.apres_retrait, RaisonsPlanificateur.COURSES_FUSIONNEES);
    const refAbsorbee = p.lu.instantane.courses.find((k) => k.id === a.absorbee_id)?.reference ?? null;
    if (refAbsorbee) p.absorbees.set(a.cible_id, [...(p.absorbees.get(a.cible_id) ?? []), refAbsorbee]);
    await this.journal.ecrire({
      type: 'COURSES_FUSIONNEES',
      motif: a.motif ?? 'GROUPE',
      source: 'serveur',
      restaurant_id: p.restaurantId,
      course_id: a.cible_id,
      deliverer_id: a.deliverer_id,
      details: {
        cible: refCible,
        absorbee_id: a.absorbee_id,
        commandes: a.order_ids.length,
        offres_closes: a.offres_a_clore.length,
        libelle: a.libelle,
        detour_s: a.detour_s,
      },
    });

    // Course absorbée annulée : socket au siège et au restaurant.
    const absorbee = await this.prisma.course.findUnique({ where: { id: a.absorbee_id }, include: COURSE_FULL_INCLUDE });
    if (absorbee) {
      await this.courseEvent.courseCancelled({
        course: absorbee,
        cancelled_by: 'system',
        reason: absorbee.cancelled_reason ?? 'Fusionnée',
      });
    }
  }

  private noterAjout(p: Passage, courseId: string, n: number, apresRetrait: boolean, raison: RaisonPlanificateur): void {
    const avant = p.ajouts.get(courseId);
    p.ajouts.set(courseId, { n: (avant?.n ?? 0) + n, apresRetrait: (avant?.apresRetrait ?? false) || apresRetrait });
    p.touchees.set(courseId, raison);
  }

  /** Commande antérieure au code client : le code tiré pour la livraison est recopié sur la commande. */
  private async reporterCodeClient(orderId: string): Promise<void> {
    const d = await this.prisma.delivery.findFirst({
      where: { order_id: orderId, order: { recovery_code: null } },
      select: { delivery_pin: true },
    });
    if (!d?.delivery_pin) return;
    await this.prisma.order
      .update({ where: { id: orderId }, data: { recovery_code: d.delivery_pin } })
      .catch((e) => this.logger.error(`Report du code sur la commande ${orderId} échoué : ${e?.message}`));
  }

  // ─── Ordre des arrêts ─────────────────────────────────────────────────────

  private async ordonner(a: ActionOrdonner, p: Passage): Promise<void> {
    // Contrainte unique (course, rang) : on décale d'abord toutes les
    // livraisons au-delà du plus grand rang, puis on pose les rangs voulus.
    const change = await this.prisma.$transaction(async (tx) => {
      const livraisons = await tx.delivery.findMany({
        where: { course_id: a.course_id },
        select: { id: true, order_id: true, statut: true, sequence_order: true },
      });
      const rangs = numeroterArrets(livraisons, a.sequence);
      if (!rangs) return false;
      const max = Math.max(...livraisons.map((l) => l.sequence_order));
      await tx.delivery.updateMany({ where: { course_id: a.course_id }, data: { sequence_order: { increment: max } } });
      for (const [id, rang] of rangs) {
        await tx.delivery.updateMany({ where: { id, course_id: a.course_id }, data: { sequence_order: rang } });
      }
      return true;
    });
    if (!change) return;
    if (!p.touchees.has(a.course_id)) p.touchees.set(a.course_id, RaisonsPlanificateur.COMMANDE_AJOUTEE);
    await this.journal.ecrire({
      type: 'ARRETS_ORDONNES',
      source: 'serveur',
      restaurant_id: p.restaurantId,
      course_id: a.course_id,
      details: { sequence: a.sequence },
    });
  }

  // ─── Offres, retenues, Turbo ──────────────────────────────────────────────

  private async offrir(a: ActionOffrir, p: Passage): Promise<void> {
    const courseId = a.course_id ?? p.cles.get(a.course_cle) ?? null;
    if (!courseId) throw new ActionAbandonnee('COURSE_NON_CREEE');

    // Gardé d'aujourd'hui : trop de refus, la course expire au lieu d'être reproposée.
    const refus = p.lu.contexte.refus.get(courseId) ?? 0;
    if (refus >= p.options.maxRefus) {
      const { count } = await this.prisma.course.updateMany({
        where: { id: courseId, statut: CourseStatut.PENDING_ASSIGNMENT },
        data: { statut: CourseStatut.EXPIRED, offer_expires_at: null },
      });
      if (count === 1) this.logger.warn(`Course ${courseId.slice(0, 8)} : seuil de refus atteint (${refus}), EXPIRED`);
      throw new ActionAbandonnee('SEUIL_DE_REFUS');
    }

    const envoyee = await this.offres.offerToDeliverer(courseId, a.deliverer_id);
    if (!envoyee) throw new ActionAbandonnee('OFFRE_NON_CREEE');
    await this.journal.ecrire({
      type: 'OFFRE_PLANIFIEE',
      motif: a.cout.au_comptoir ? 'AU_COMPTOIR' : 'MINUTES',
      source: 'serveur',
      restaurant_id: p.restaurantId,
      course_id: courseId,
      deliverer_id: a.deliverer_id,
      details: {
        libelle: a.libelle,
        marge_s: a.marge_s,
        cout_min: Math.round(a.cout.cout_min * 10) / 10,
        eta_s: Math.round(a.cout.eta_s),
        source_eta: a.cout.source_eta,
        rang_file: a.cout.rang_file,
      },
    });
  }

  /**
   * Offre en attente reprise sans pénalité : un livreur libre serait au
   * restaurant bien plus tôt. Réservation atomique de la clôture (offre
   * encore en attente) : si le livreur sollicité vient d'accepter, son
   * acceptation l'emporte, la reprise est abandonnée et l'offre qui suit
   * aussi (la course n'est plus en recherche).
   */
  private async reprendreOffre(a: ActionReprendreOffre, p: Passage): Promise<void> {
    if (!a.offre.id) throw new ActionAbandonnee('OFFRE_INCONNUE');
    const closes = await this.cloture.cloreOffre(a.offre.id, 'COURSE_REPRISE', {
      relancerRecherche: false,
      maintenant: p.maintenant,
      details: { pour: a.pour_deliverer_id, libelle: a.libelle },
    });
    if (closes.length !== 1) throw new ActionAbandonnee('OFFRE_CHANGEE');
  }

  private async retenir(a: ActionRetenir, p: Passage): Promise<void> {
    const now = p.maintenant;
    const avant = p.lu.instantane.courses.find((k) => k.id === a.course_id);
    const { count } = await this.prisma.course.updateMany({
      where: {
        id: a.course_id,
        statut: { in: STATUTS_AVEC_LIVREUR },
        parti_at: null,
        // Une retenue ne peut que diminuer ; terminée, elle ne revient que
        // pour une commande entrée en préparation après sa fin, et seulement
        // si elle n'a pas bougé depuis la lecture (claim atomique).
        OR: [
          { retenue_jusqua: null },
          { retenue_jusqua: { gt: now, gte: a.jusqua } },
          ...(a.reprise_de ? [{ retenue_jusqua: a.reprise_de }] : []),
        ],
      },
      data: { retenue_jusqua: a.jusqua, commandes_attendues: commandesAttenduesAEcrire(a.attendues) as unknown as Prisma.InputJsonValue },
    });
    if (count !== 1) throw new ActionAbandonnee('COURSE_CHANGEE');
    // Raison secondaire : un ajout ou une fusion du même passage reste la raison annoncée.
    if (!p.touchees.has(a.course_id)) p.touchees.set(a.course_id, RaisonsPlanificateur.RETENUE);
    await this.journal.ecrire({
      type: 'COURSE_RETENUE',
      // Attente courte, ou trajet long (le livreur reviendrait trop tard pour la commande attendue).
      motif: a.motif,
      source: 'serveur',
      restaurant_id: p.restaurantId,
      course_id: a.course_id,
      deliverer_id: a.deliverer_id,
      details: {
        jusqua: a.jusqua.toISOString(),
        attendues: a.attendues.map((x) => `${x.reference}(${x.prete_vers.toISOString()})`),
        aller_retour_s: a.aller_retour_s,
        libelle: a.libelle,
      },
    });
    // Première retenue de la course, ou retenue terminée reposée : le livreur
    // sera prévenu (vibration, notification).
    if (!avant?.retenue_jusqua || avant.retenue_jusqua.getTime() <= now.getTime()) {
      p.retenues.set(a.course_id, { jusqua: a.jusqua, attendues: a.attendues.map((x) => x.reference) });
    }
  }

  private async liberer(a: ActionLiberer, p: Passage): Promise<void> {
    const { count } = await this.prisma.course.updateMany({
      where: { id: a.course_id, retenue_jusqua: { not: null } },
      data: { retenue_jusqua: a.jusqua, commandes_attendues: [] },
    });
    if (count !== 1) throw new ActionAbandonnee('COURSE_CHANGEE');
    // Raison secondaire : la commande attendue ajoutée dans le même passage
    // reste la raison annoncée (l'écran Opérations en fait son avis « ajoutée »).
    if (!p.touchees.has(a.course_id)) p.touchees.set(a.course_id, RaisonsPlanificateur.RETENUE_LEVEE);
    await this.journal.ecrire({
      type: 'RETENUE_LEVEE',
      motif: a.motif,
      source: 'serveur',
      restaurant_id: p.restaurantId,
      course_id: a.course_id,
      deliverer_id: a.deliverer_id,
      details: { libelle: a.libelle },
    });
    p.liberations.set(a.course_id, a.motif);
  }

  private async confierTurbo(a: ActionConfierTurbo, p: Passage): Promise<void> {
    const echecRecent = await this.prisma.dispatchEvenement.findFirst({
      where: {
        type: 'TURBO_PLANIFIE',
        motif: 'ECHEC',
        course_id: a.course_id,
        created_at: { gt: new Date(p.maintenant.getTime() - PAUSE_APRES_ECHEC_TURBO_MS) },
      },
      select: { id: true },
    });
    if (echecRecent) throw new ActionAbandonnee(MOTIF_TURBO_PAS_AVANT);
    const journaliser = (confiee: boolean, details: Record<string, unknown> = {}) =>
      this.journal.ecrire({
        type: 'TURBO_PLANIFIE',
        motif: confiee ? 'CONFIEE' : 'ECHEC',
        source: 'serveur',
        restaurant_id: p.restaurantId,
        course_id: a.course_id,
        details: { minutes: a.minutes, libelle: a.libelle, ...details },
      });
    const envoi = this.offres.confierATurboParPlanificateur(a.course_id, a.minutes).catch((err) => {
      this.logger.warn(`Envoi à Turbo en échec (${a.course_id.slice(0, 8)}) : ${(err as Error)?.message ?? err}`);
      return false;
    });
    let minuteur: NodeJS.Timeout | undefined;
    const delai = new Promise<'DELAI'>((resoudre) => {
      minuteur = setTimeout(() => resoudre('DELAI'), DELAI_ENVOI_TURBO_MS);
      minuteur.unref?.();
    });
    const issue = await Promise.race([envoi, delai]).finally(() => clearTimeout(minuteur));
    if (issue === 'DELAI') {
      // Le passage n'attend plus : l'issue sera journalisée à son arrivée.
      void envoi.then((confiee) => journaliser(confiee, { reponse_tardive: true })).catch(() => undefined);
      throw new ActionAbandonnee('TURBO_SANS_REPONSE');
    }
    await journaliser(issue);
    if (!issue) throw new ActionAbandonnee('TURBO_INDISPONIBLE');
  }

  // ─── Annonces ─────────────────────────────────────────────────────────────

  /**
   * Commande retirée d'une course HORS du passage (commande à livrer passée à
   * emporter ou sur place, demande du 27/10) : exactement les annonces d'une
   * commande détachée par le planificateur. `course:statut:changed` raison
   * COMMANDE_DETACHEE (livreur, restaurant, siège : la caisse relit la
   * course), « Commande retirée » au livreur affecté, offre à jour renvoyée au
   * livreur sollicité si la course est encore en recherche.
   */
  async annoncerRetrait(courseId: string, references: string[], maintenant = new Date()): Promise<void> {
    await this.annoncer({
      maintenant,
      touchees: new Map([[courseId, RaisonsPlanificateur.COMMANDE_DETACHEE]]),
      ajouts: new Map(),
      retirees: new Map([[courseId, references]]),
      retenues: new Map(),
      liberations: new Map(),
      absorbees: new Map(),
    });
  }

  /**
   * Une fois tout écrit : `course:statut:changed` pour chaque course touchée
   * (livreur, restaurant, siège), offre en attente renvoyée à jour au livreur
   * sollicité (même échéance), notifications au livreur affecté.
   */
  private async annoncer(p: Annonces): Promise<void> {
    for (const [courseId, raison] of p.touchees) {
      try {
        const course = await this.prisma.course.findUnique({ where: { id: courseId }, include: COURSE_FULL_INCLUDE });
        if (!course) continue;
        const absorbees = p.absorbees.get(courseId);
        await this.courseEvent.courseStatutChanged({
          course,
          previous_statut: course.statut,
          new_statut: course.statut,
          reason: raison,
          // Fusion : l'écran Opérations nomme les courses absorbées.
          ...(absorbees?.length ? { fusion: { absorbees } } : {}),
        });

        await this.annoncerAuLivreur(course, p);
      } catch (err) {
        this.logger.warn(`Annonce de la course ${courseId.slice(0, 8)} impossible : ${(err as Error)?.message}`);
      }
    }
  }

  /**
   * Ce que le livreur doit sentir (vibration et notification sur le canal des
   * offres) : UNE notification par course et par passage, la plus utile
   *  1. commande retirée à son départ ;
   *  2. tout est prêt (retenue levée, livreur au comptoir, pas parti) ; après
   *     la remise, « Commande ajoutée · code » si une commande vient d'être
   *     ajoutée, « Tout est prêt » avec les sacs qui restent, sinon « Tout
   *     est récupéré » ;
   *  3. attente posée (« Attends 3 min », livreur au comptoir) ;
   *  4. commande(s) ajoutée(s).
   * Course encore en recherche avec une offre en attente : l'offre à jour est
   * renvoyée au livreur sollicité, même échéance (l'appli remplace l'offre).
   */
  private async annoncerAuLivreur(
    course: Prisma.CourseGetPayload<{ include: typeof COURSE_FULL_INCLUDE }>,
    p: Annonces,
  ): Promise<void> {
    const ajout = p.ajouts.get(course.id);
    const total = course.deliveries.filter((d) => !STATUTS_LIVRAISON_TERMINEE.includes(d.statut)).length;

    const retirees = p.retirees.get(course.id);
    if (course.statut === CourseStatut.PENDING_ASSIGNMENT) {
      // Commande ajoutée ou retirée : l'offre affichée n'est plus la bonne.
      if (ajout || retirees?.length) await this.renvoyerOffre(course, p);
      return;
    }
    const livreur = course.deliverer_id;
    if (!livreur || !STATUTS_AVEC_LIVREUR.includes(course.statut)) return;

    if (retirees?.length) {
      const texte = texteCommandeRetiree({ reference: retirees[0], restantes: total });
      this.push.notifyCommandeRetiree({
        delivererId: livreur,
        courseId: course.id,
        titre: texte.titre,
        corps: texte.corps,
        commande: retirees.join(', '),
        restantes: total,
      });
      return;
    }

    // Course acceptée, livreur encore en route : ni « Attends 4 min » (il
    // croirait devoir attendre avant de rouler) ni « Tout est prêt » (la
    // retenue ne lui a jamais été annoncée). La retenue en cours lui est
    // annoncée à son arrivée au comptoir (RetenueALArriveeListener), minutes
    // comptées de là ; une commande ajoutée lui est toujours annoncée.
    const enRoute = course.statut === CourseStatut.ACCEPTED;
    const liberation = p.liberations.get(course.id);
    const pasParti = course.statut !== CourseStatut.IN_DELIVERY || !course.parti_at;
    if (liberation && liberationAAnnoncer(liberation) && pasParti && !enRoute && course.statut === CourseStatut.IN_DELIVERY) {
      // Levée APRÈS la remise (la caisse remet dès le code, essai du 25/10) :
      // « Tout est prêt · 2 commandes » lui ferait compter des sacs déjà
      // remis. Une commande vient d'être ajoutée dans ce passage : « Commande
      // ajoutée / Code 421 au restaurant ». Un sac reste à prendre sans ajout
      // (remise commande par commande, ajout déjà annoncé) : « Tout est prêt /
      // 1 commande · code 421 », les sacs qui restent. Rien à prendre : « Tout
      // est récupéré / Tu peux partir ».
      const sacs = course.deliveries.filter(
        (d) => !STATUTS_LIVRAISON_TERMINEE.includes(d.statut) && d.order.status === OrderStatus.READY,
      ).length;
      if (ajout) {
        const texte = texteCommandeAjoutee({ ajoutees: ajout.n, total, apresRetrait: true, code: course.pickup_code });
        this.push.notifyCommandeAjoutee({
          delivererId: livreur,
          courseId: course.id,
          courseReference: course.reference,
          titre: texte.titre,
          corps: texte.corps,
          ajoutees: ajout.n,
          total,
          apresRetrait: true,
          code: course.pickup_code,
        });
      } else if (sacs > 0) {
        const texte = texteToutEstPret({ code: course.pickup_code, total: sacs });
        this.push.notifyCourseToutPret({
          delivererId: livreur,
          courseId: course.id,
          titre: texte.titre,
          corps: texte.corps,
          code: course.pickup_code,
        });
      } else {
        const texte = texteCommandeRemise();
        this.push.notifyCommandeRemise({ delivererId: livreur, courseId: course.id, titre: texte.titre, corps: texte.corps });
      }
      return;
    }
    if (liberation && liberationAAnnoncer(liberation) && pasParti && !enRoute) {
      const texte = texteToutEstPret({ code: course.pickup_code, total });
      this.push.notifyCourseToutPret({
        delivererId: livreur,
        courseId: course.id,
        titre: texte.titre,
        corps: texte.corps,
        code: course.pickup_code,
      });
      return;
    }

    const retenue = enRoute ? undefined : p.retenues.get(course.id);
    if (retenue) {
      const texte = texteRetenue({ jusqua: retenue.jusqua, maintenant: p.maintenant });
      this.push.notifyCourseAttente({
        delivererId: livreur,
        courseId: course.id,
        titre: texte.titre,
        corps: texte.corps,
        jusqua: retenue.jusqua,
        attendues: retenue.attendues,
      });
      return;
    }

    if (ajout) {
      const texte = texteCommandeAjoutee({ ajoutees: ajout.n, total, apresRetrait: ajout.apresRetrait, code: course.pickup_code });
      this.push.notifyCommandeAjoutee({
        delivererId: livreur,
        courseId: course.id,
        courseReference: course.reference,
        titre: texte.titre,
        corps: texte.corps,
        ajoutees: ajout.n,
        total,
        apresRetrait: ajout.apresRetrait,
        code: course.pickup_code,
      });
    }
  }

  /** Course encore en recherche : le livreur sollicité reçoit l'offre à jour, même échéance. */
  private async renvoyerOffre(course: Prisma.CourseGetPayload<{ include: typeof COURSE_FULL_INCLUDE }>, p: Annonces): Promise<void> {
    const offre = await this.prisma.courseOfferAttempt.findFirst({
      where: { course_id: course.id, status: CourseOfferStatus.PENDING, expires_at: { gt: p.maintenant } },
      select: { deliverer_id: true, expires_at: true },
    });
    if (!offre) return;
    await this.courseEvent.offerNew({
      course,
      deliverer_id: offre.deliverer_id,
      offer_id: course.id,
      expires_at: offre.expires_at,
      is_chain_bonus: false,
      renvoi: true,
    });
  }

  /**
   * Repli v1 : commandes prêtes laissées sans lot ni course par v2 (passage
   * en échec, prêtes pendant le basculement) rendues à l'ancien regroupement
   * par lots, qui crée leur course à la fin de sa fenêtre.
   *
   * @returns le nombre de commandes mises dans un lot.
   */
  async rendreAuxLots(orderIds: readonly string[]): Promise<number> {
    let n = 0;
    for (const id of orderIds) {
      try {
        const { batchId } = await this.regroupement.tryGroupOrder(id);
        if (batchId) n++;
      } catch (err) {
        this.logger.warn(`Commande ${id.slice(0, 8)} non rendue aux lots : ${(err as Error)?.message}`);
      }
    }
    if (n > 0) this.logger.log(`Retour à l'ancienne méthode : ${n} commande(s) prête(s) sans course rendue(s) aux lots.`);
    return n;
  }

  /** Contexte de lecture (pour les tests). */
  static contexteVide(restaurantId: string): ContexteInstantane {
    return { restaurant: { id: restaurantId, name: null, position: null }, codes: new Map(), refus: new Map() };
  }
}
