import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { CourseStatut, DeliveryService, DeliveryStatut, EntityStatus, OrderStatus, OrderType, Prisma } from '@prisma/client';

import { PrismaService } from 'src/database/services/prisma.service';

import { CourseSettingsHelper } from '../helpers/course-settings.helper';
import {
  actionsRepliV1,
  CLASSE_VERROU_PLANIFICATEUR,
  planificateurDuRestaurant,
  planifier,
  PlanRestaurant,
  RefusPlanification,
  TypeActionPlanification,
  VersionPlanificateur,
} from '../helpers/planification.rules';
import { ApplicationPlanService } from './application-plan.service';
import { DispatchJournalService } from './dispatch-journal.service';
import { FRAICHEUR_COURSE_EN_LIVRAISON_MS, InstantanePlanificationService } from './instantane-planification.service';

/** Demandes d'un même restaurant regroupées pendant ce délai (conception 3.12). */
export const DELAI_REGROUPEMENT_MS = 500;
/** Passage plus long que ça : le verrou est rendu (la transaction qui le tient est close). */
const DUREE_MAX_PASSAGE_MS = 60_000;
/**
 * Plus aucune action commencée après 40 s de passage : la plus longue (Turbo,
 * 15 s au plus) finit avant que la transaction du verrou ne soit close.
 */
const ECHEANCE_ACTIONS_MS = 40_000;
/** Une commande sans course plus vieille que ça n'est plus du service en cours. */
const FRAICHEUR_COMMANDE_MS = 6 * 60 * 60 * 1000;
/**
 * Repli v1 : une commande prête de la flotte interne sans lot ni course
 * depuis plus d'une minute a été laissée par v2 (passage en échec, ou prête
 * pendant le basculement) ; le pont des commandes de v1 l'aurait mise dans un
 * lot à l'instant où elle est devenue prête.
 */
export const DELAI_COMMANDE_SANS_LOT_MS = 60_000;
/**
 * Verrou du restaurant tenu par un autre serveur : la demande est refaite une
 * seconde plus tard (au plus 10 fois de suite ; la tâche de 10 s reste le filet).
 */
export const DELAI_NOUVELLE_DEMANDE_MS = 1000;
const NOUVELLES_DEMANDES_MAX = 10;
/**
 * Réveil à l'échéance d'une retenue : un passage 300 ms après
 * `retenue_jusqua` au lieu d'attendre la tâche de 10 s (banc du 23/10 : la
 * retenue échue était levée 2,5 à 5 s après, jusqu'à 10 s ; le livreur au
 * comptoir attendait d'autant son « Tu peux partir »).
 */
export const MARGE_REVEIL_RETENUE_MS = 300;
/**
 * Journal des refus (PLAN_REFUS) : un même refus (restaurant, essai,
 * commande ou course essayée, course cible, motif) au plus une fois par
 * 10 min et par serveur. Mémoire bornée à 5 000 refus.
 */
export const DELAI_REFUS_JOURNALISE_MS = 10 * 60_000;
const REFUS_JOURNALISES_MAX = 5000;
/** Essais dont les refus sont journalisés : ceux qui disent pourquoi une commande n'a pas rejoint une course. */
const ESSAIS_JOURNALISES: readonly RefusPlanification['essai'][] = ['AJOUT', 'FUSION', 'RETENUE'];

export interface ResultatPassage {
  restaurant_id: string;
  version: VersionPlanificateur;
  /** Faux : un autre serveur (ou un autre passage) tenait le verrou du restaurant ; rien n'a été fait. */
  verrou: boolean;
  appliquees: TypeActionPlanification[];
  abandonnees: { type: TypeActionPlanification; motif: string }[];
  /** Courses créées : clé du plan (`nouvelle-N`) vers identifiant. */
  creees: Map<string, string>;
  /** Repli v1 : commandes prêtes laissées sans lot par v2, rendues à l'ancien regroupement. */
  rendues_aux_lots?: number;
}

/**
 * PLANIFICATEUR v2 (conception 3, 4.2 et 5.5 ; demandes du 22/10).
 *
 * Un PASSAGE sur un restaurant : sous le verrou consultatif Postgres du
 * restaurant (`CLASSE_VERROU_PLANIFICATEUR`), lecture de l'instantané
 * (commandes, courses, livreurs, verdicts de direction), calcul du plan par
 * la règle pure `planifier`, puis application conditionnelle et journalisée
 * de chaque action (`ApplicationPlanService`).
 *
 * Déclenché :
 *  - par les événements (commande prête, en préparation, annulée ; course
 *    créée, acceptée, refusée, expirée, au restaurant, retrait validé,
 *    partie, annulée, terminée ; livreur disponible, en pause, reprise,
 *    appli connectée), regroupés par restaurant pendant 500 ms
 *    (`demander`, `PlanificateurListener`) ;
 *  - par la tâche de 10 s (échéances : fenêtre après retrait, Turbo ;
 *    commandes prêtes sans événement) ;
 *  - à l'échéance d'une retenue (réveil programmé après chaque passage).
 *
 * Aiguillage : `course.planificateur` (`v2` par défaut, `v1` = l'ancien
 * regroupement par lots) et `course.planificateur_restaurants` (vide = tous).
 * Un restaurant en v1 ne voit que le REPLI : ses courses récupérées encore
 * « au restaurant » sont marquées parties, les commandes ajoutées après le
 * retrait et pas remises, et les commandes prêtes laissées sans lot ni course
 * depuis plus d'une minute, sont rendues à l'ancien regroupement, les
 * retenues levées. Le reste de v1 est exactement le comportement d'avant.
 *
 * Verrou pris par un autre serveur : la demande est refaite une seconde plus
 * tard. Aucune action n'est commencée après 40 s de passage (le verrou est
 * tenu par une transaction de 60 s au plus).
 *
 * Sans état propre : tout est relu à chaque passage, deux serveurs peuvent
 * tourner (le verrou les fait passer l'un après l'autre, les écritures sont
 * conditionnelles). Dans un même serveur, les passages s'enchaînent un par
 * un (une seule connexion tenue par un verrou à la fois).
 */
@Injectable()
export class CoursePlanificateurService implements OnModuleDestroy {
  private readonly logger = new Logger('Dispatch');
  /** Demandes en cours de regroupement, par restaurant. */
  private readonly demandes = new Map<string, { minuteur: NodeJS.Timeout; raisons: Set<string> }>();
  /** Restaurants en file (pas encore commencés), avec les raisons cumulées. */
  private readonly enFile = new Map<string, Set<string>>();
  private file: Promise<unknown> = Promise.resolve();
  private arrete = false;
  /** Verrou pris ailleurs : demandes refaites de suite, par restaurant. */
  private readonly verrouPrisAilleurs = new Map<string, number>();
  private readonly minuteursNouvelleDemande = new Set<NodeJS.Timeout>();
  /** Réveil programmé à la prochaine échéance de retenue, par restaurant (ce serveur). */
  private readonly reveils = new Map<string, { a: number; minuteur: NodeJS.Timeout }>();
  /** Refus déjà journalisés (clé du refus → heure), ce serveur. */
  private readonly refusJournalises = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: CourseSettingsHelper,
    private readonly instantanes: InstantanePlanificationService,
    private readonly application: ApplicationPlanService,
    @Optional() private readonly journal?: DispatchJournalService,
  ) {}

  onModuleDestroy() {
    this.arrete = true;
    for (const { minuteur } of this.demandes.values()) clearTimeout(minuteur);
    this.demandes.clear();
    for (const m of this.minuteursNouvelleDemande) clearTimeout(m);
    this.minuteursNouvelleDemande.clear();
    for (const { minuteur } of this.reveils.values()) clearTimeout(minuteur);
    this.reveils.clear();
  }

  /**
   * Demande un passage pour ce restaurant. Les demandes arrivées pendant
   * 500 ms sont regroupées en un seul passage.
   */
  demander(restaurantId: string | null | undefined, raison: string): void {
    if (!restaurantId || this.arrete) return;
    const deja = this.demandes.get(restaurantId);
    if (deja) {
      deja.raisons.add(raison);
      return;
    }
    const raisons = new Set([raison]);
    const minuteur = setTimeout(() => {
      this.demandes.delete(restaurantId);
      void this.enfiler(restaurantId, [...raisons]);
    }, DELAI_REGROUPEMENT_MS);
    minuteur.unref?.();
    this.demandes.set(restaurantId, { minuteur, raisons });
  }

  /**
   * Met un passage en file. Un restaurant déjà en file (pas encore commencé)
   * n'est pas mis deux fois : ses raisons s'ajoutent. Les passages de ce
   * serveur s'enchaînent un par un.
   */
  enfiler(restaurantId: string, raisons: string[]): Promise<unknown> {
    const deja = this.enFile.get(restaurantId);
    if (deja) {
      raisons.forEach((r) => deja.add(r));
      return this.file;
    }
    this.enFile.set(restaurantId, new Set(raisons));
    this.file = this.file.then(async () => {
      const cumul = this.enFile.get(restaurantId) ?? new Set<string>();
      this.enFile.delete(restaurantId);
      try {
        await this.planifierRestaurant(restaurantId, [...cumul].join(','));
      } catch (err) {
        this.logger.error(`Passage du planificateur en échec (${restaurantId.slice(0, 8)}) : ${(err as Error)?.message ?? err}`);
      }
    });
    return this.file;
  }

  /**
   * Tâche de 10 s : un passage pour chaque restaurant qui a de quoi planifier
   * (commandes à livrer sans course, courses ouvertes ou récupérées encore au
   * restaurant). Rend la promesse de la file (tests).
   */
  async passerTout(maintenant = new Date()): Promise<unknown> {
    const restaurants = await this.restaurantsActifs(maintenant);
    for (const id of restaurants) void this.enfiler(id, ['TACHE']);
    return this.file;
  }

  /** Un passage, tout de suite (sans regroupement). `null` si rien n'a été tenté. */
  async planifierRestaurant(
    restaurantId: string,
    raison = 'TACHE',
    horloge: () => Date = () => new Date(),
  ): Promise<ResultatPassage | null> {
    const lue = await this.settings.lirePlanification();
    const version = planificateurDuRestaurant(lue.planificateur, restaurantId);
    // v1 : rien à faire tant qu'il ne reste rien de v2 (cas normal).
    if (version === 'v1' && !(await this.aDesRestesV2(restaurantId, horloge()))) return null;

    const resultat = await this.sousVerrou(restaurantId, async (): Promise<ResultatPassage> => {
      const maintenant = horloge();
      const echeanceMs = Date.now() + ECHEANCE_ACTIONS_MS;
      const { reglages, google } = lue.planification;
      const lu = await this.instantanes.lire(restaurantId, maintenant, reglages, google, lue.preparation.reglages);

      let plan: PlanRestaurant;
      if (version === 'v1') {
        plan = { restaurant_id: restaurantId, maintenant, actions: actionsRepliV1(lu.instantane), refus: [] };
      } else {
        plan = planifier(lu.instantane, reglages, { verdicts: lu.verdicts });
        // Une course est proposée : temps Google des livreurs (si le réglage
        // le permet), et nouveau calcul avec eux.
        if (plan.actions.some((a) => a.type === 'OFFRIR') && (await this.instantanes.completerTempsGoogle(lu.instantane, reglages))) {
          plan = planifier(lu.instantane, reglages, { verdicts: lu.verdicts });
        }
      }

      const vide: ResultatPassage = {
        restaurant_id: restaurantId,
        version,
        verrou: true,
        appliquees: [],
        abandonnees: [],
        creees: new Map(),
      };
      // Repli v1 : les commandes prêtes laissées sans lot ni course par v2
      // repartent dans l'ancien regroupement.
      const rendues = version === 'v1' ? await this.application.rendreAuxLots(await this.commandesSansLot(restaurantId, maintenant)) : 0;
      if (rendues > 0) vide.rendues_aux_lots = rendues;
      // Refus journalisés avant tout (passage sans action compris) : observation, aucune décision n'en dépend.
      await this.journaliserRefus(restaurantId, plan.refus, new Set(lu.instantane.courses.map((k) => k.id)), maintenant);
      if (plan.actions.length === 0) return vide;

      const { maxRefusalCount } = await this.settings.load();
      const applique = await this.application.appliquer(plan, lu, {
        maxRefus: maxRefusalCount,
        repliV1: version === 'v1',
        echeanceMs,
      });
      this.logger.log(
        JSON.stringify({
          planificateur: version,
          restaurant: restaurantId,
          raison,
          appliquees: applique.appliquees,
          abandonnees: applique.abandonnees.map((a) => `${a.type}:${a.motif}`),
        }),
      );
      return { ...vide, appliquees: applique.appliquees, abandonnees: applique.abandonnees, creees: applique.creees };
    });

    if (resultat) {
      this.verrouPrisAilleurs.delete(restaurantId);
      if (version === 'v2') {
        await this.programmerReveil(restaurantId).catch((err) =>
          this.logger.warn(`Réveil à l'échéance de la retenue non programmé : ${(err as Error)?.message ?? err}`),
        );
      }
      return resultat;
    }
    this.redemanderPlusTard(restaurantId);
    return {
      restaurant_id: restaurantId,
      version,
      verrou: false,
      appliquees: [],
      abandonnees: [],
      creees: new Map(),
    };
  }

  /**
   * Un autre serveur planifie ce restaurant : il a lu son instantané avant
   * l'événement qui nous a réveillés et ne l'a peut-être pas vu. La demande
   * est refaite une seconde plus tard au lieu d'attendre la tâche de 10 s.
   */
  private redemanderPlusTard(restaurantId: string): void {
    if (this.arrete) return;
    const n = (this.verrouPrisAilleurs.get(restaurantId) ?? 0) + 1;
    this.verrouPrisAilleurs.set(restaurantId, n);
    if (n > NOUVELLES_DEMANDES_MAX) return;
    const minuteur = setTimeout(() => {
      this.minuteursNouvelleDemande.delete(minuteur);
      this.demander(restaurantId, 'VERROU_PRIS');
    }, DELAI_NOUVELLE_DEMANDE_MS);
    minuteur.unref?.();
    this.minuteursNouvelleDemande.add(minuteur);
  }

  /**
   * Prochaine échéance de retenue du restaurant : un passage est programmé
   * juste après (`MARGE_REVEIL_RETENUE_MS`). Un réveil plus tôt déjà prévu est
   * gardé ; un plus tard est remplacé. État de ce serveur seulement : un
   * réveil perdu (redémarrage) laisse la tâche de 10 s faire le travail, et
   * deux serveurs réveillés passent l'un après l'autre (verrou), le second
   * sans rien à faire.
   */
  private async programmerReveil(restaurantId: string): Promise<void> {
    if (this.arrete) return;
    const maintenant = Date.now();
    const prochaine = await this.prisma.course.findFirst({
      where: {
        restaurant_id: restaurantId,
        statut: { in: [CourseStatut.PENDING_ASSIGNMENT, CourseStatut.ACCEPTED, CourseStatut.AT_RESTAURANT, CourseStatut.IN_DELIVERY] },
        retenue_jusqua: { gt: new Date(maintenant) },
      },
      orderBy: { retenue_jusqua: 'asc' },
      select: { retenue_jusqua: true },
    });
    const a = prochaine?.retenue_jusqua?.getTime();
    if (!a) return;
    const deja = this.reveils.get(restaurantId);
    if (deja && deja.a <= a) return;
    if (deja) clearTimeout(deja.minuteur);
    const minuteur = setTimeout(() => {
      this.reveils.delete(restaurantId);
      void this.enfiler(restaurantId, ['ECHEANCE_RETENUE']);
    }, a - maintenant + MARGE_REVEIL_RETENUE_MS);
    minuteur.unref?.();
    this.reveils.set(restaurantId, { a, minuteur });
  }

  /**
   * PLAN_REFUS (essai du 25/10 : on ne pouvait pas savoir quel refus avait
   * joué). Un même refus au plus une fois par 10 min (deux serveurs : deux
   * lignes au plus). `course_id` : seulement l'identifiant d'une course lue,
   * jamais la clé d'une course du plan (`nouvelle-1`), qui reste dans
   * `details`. Au mieux : une écriture en échec ne touche pas le passage.
   */
  private async journaliserRefus(
    restaurantId: string,
    refus: readonly RefusPlanification[],
    coursesLues: ReadonlySet<string>,
    maintenant: Date,
  ): Promise<void> {
    if (!this.journal) return;
    const t = maintenant.getTime();
    for (const x of refus) {
      if (!ESSAIS_JOURNALISES.includes(x.essai)) continue;
      const cle = [restaurantId, x.essai, x.order_id ?? x.source_id ?? '', x.course_cle, x.refus].join('|');
      const vu = this.refusJournalises.get(cle);
      if (vu !== undefined && t - vu < DELAI_REFUS_JOURNALISE_MS) continue;
      this.retenirRefus(cle, t);
      try {
        await this.journal.ecrire({
          type: 'PLAN_REFUS',
          motif: x.refus,
          source: 'serveur',
          restaurant_id: restaurantId,
          course_id: coursesLues.has(x.course_cle) ? x.course_cle : null,
          order_id: x.order_id,
          details: { essai: x.essai, course_cle: x.course_cle, source_id: x.source_id, libelle: x.libelle },
        });
      } catch {
        // Le journal n'échoue jamais ; par prudence, rien ne remonte au passage.
      }
    }
  }

  /** Mémoire des refus bornée : les plus vieux d'abord, puis les plus anciens écrits. */
  private retenirRefus(cle: string, t: number): void {
    this.refusJournalises.delete(cle);
    if (this.refusJournalises.size >= REFUS_JOURNALISES_MAX) {
      for (const [c, vu] of this.refusJournalises) if (t - vu >= DELAI_REFUS_JOURNALISE_MS) this.refusJournalises.delete(c);
      for (const c of this.refusJournalises.keys()) {
        if (this.refusJournalises.size < REFUS_JOURNALISES_MAX) break;
        this.refusJournalises.delete(c);
      }
    }
    this.refusJournalises.set(cle, t);
  }

  /** Repli v1 : commandes prêtes de la flotte interne sans lot ni course depuis plus d'une minute. */
  private whereCommandesSansLot(restaurantId: string, maintenant: Date): Prisma.OrderWhereInput {
    const avant = new Date(maintenant.getTime() - DELAI_COMMANDE_SANS_LOT_MS);
    return {
      restaurant_id: restaurantId,
      type: OrderType.DELIVERY,
      delivery_service: DeliveryService.CHICKEN_NATION,
      status: OrderStatus.READY,
      entity_status: { not: EntityStatus.DELETED },
      delivery: null,
      batch_id: null,
      updated_at: { gte: new Date(maintenant.getTime() - FRAICHEUR_COMMANDE_MS) },
      OR: [{ ready_at: { lte: avant } }, { ready_at: null, updated_at: { lte: avant } }],
    };
  }

  private async commandesSansLot(restaurantId: string, maintenant: Date): Promise<string[]> {
    const lignes = await this.prisma.order.findMany({
      where: this.whereCommandesSansLot(restaurantId, maintenant),
      select: { id: true },
      orderBy: { ready_at: 'asc' },
      take: 50,
    });
    return lignes.map((l) => l.id);
  }

  /**
   * Travail sous le verrou consultatif du restaurant : une transaction tient
   * `pg_try_advisory_xact_lock` le temps du passage (le travail lui-même
   * passe par d'autres connexions). Verrou pris ailleurs : `null`, rien n'est
   * fait (le passage suivant reprendra tout).
   */
  private async sousVerrou<T>(restaurantId: string, travail: () => Promise<T>): Promise<T | null> {
    return this.prisma.$transaction(
      async (tx) => {
        const lignes = await tx.$queryRaw<{ pris: boolean }[]>`SELECT pg_try_advisory_xact_lock(${CLASSE_VERROU_PLANIFICATEUR}::int, hashtext(${restaurantId})) AS pris`;
        if (!lignes?.[0]?.pris) return null;
        return travail();
      },
      { maxWait: 10_000, timeout: DUREE_MAX_PASSAGE_MS },
    );
  }

  /**
   * Restaurant en v1 : reste-t-il quelque chose de v2 (retour en arrière en
   * pleine activité) ? Commande prête sans lot ni course depuis plus d'une
   * minute, course récupérée par un livreur interne pas encore marquée
   * partie, retenue en cours, commande ajoutée après le retrait pas remise
   * alors que le livreur est parti.
   */
  private async aDesRestesV2(restaurantId: string, maintenant: Date): Promise<boolean> {
    const sansLot = await this.prisma.order.count({ where: this.whereCommandesSansLot(restaurantId, maintenant) });
    if (sansLot > 0) return true;
    const n = await this.prisma.course.count({
      where: {
        restaurant_id: restaurantId,
        created_at: { gte: new Date(maintenant.getTime() - FRAICHEUR_COURSE_EN_LIVRAISON_MS) },
        OR: [
          { statut: CourseStatut.IN_DELIVERY, parti_at: null, deliverer_id: { not: null } },
          {
            statut: { in: [CourseStatut.ACCEPTED, CourseStatut.AT_RESTAURANT, CourseStatut.IN_DELIVERY] },
            retenue_jusqua: { gt: maintenant },
          },
          {
            statut: CourseStatut.IN_DELIVERY,
            deliveries: {
              some: {
                ajoutee_apres_retrait: true,
                statut: DeliveryStatut.PENDING,
                order: { status: OrderStatus.READY },
              },
            },
          },
        ],
      },
    });
    return n > 0;
  }

  /** Restaurants qui ont de quoi planifier maintenant. */
  private async restaurantsActifs(maintenant: Date): Promise<string[]> {
    const depuis = new Date(maintenant.getTime() - FRAICHEUR_COURSE_EN_LIVRAISON_MS);
    const [commandes, courses] = await Promise.all([
      this.prisma.order.findMany({
        where: {
          type: OrderType.DELIVERY,
          delivery_service: DeliveryService.CHICKEN_NATION,
          status: { in: [OrderStatus.READY, OrderStatus.IN_PROGRESS] },
          entity_status: { not: EntityStatus.DELETED },
          delivery: null,
          updated_at: { gte: new Date(maintenant.getTime() - FRAICHEUR_COMMANDE_MS) },
        },
        select: { restaurant_id: true },
        distinct: ['restaurant_id'],
      }),
      this.prisma.course.findMany({
        where: {
          OR: [
            { statut: { in: [CourseStatut.PENDING_ASSIGNMENT, CourseStatut.ACCEPTED, CourseStatut.AT_RESTAURANT] } },
            { statut: CourseStatut.IN_DELIVERY, parti_at: null, created_at: { gte: depuis } },
            {
              statut: CourseStatut.IN_DELIVERY,
              created_at: { gte: depuis },
              deliveries: {
                some: { ajoutee_apres_retrait: true, statut: DeliveryStatut.PENDING, order: { status: OrderStatus.READY } },
              },
            },
          ],
        },
        select: { restaurant_id: true },
        distinct: ['restaurant_id'],
      }),
    ]);
    return [...new Set([...commandes, ...courses].map((l) => l.restaurant_id).filter(Boolean))];
  }
}
