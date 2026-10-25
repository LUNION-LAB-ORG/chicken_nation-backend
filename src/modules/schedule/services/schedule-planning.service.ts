import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  DelivererStatus,
  EntityStatus,
  Prisma,
  RestDaySource,
  SchedulePlan,
  SchedulePlanStatus,
  ShiftAssignmentStatus,
  ShiftType,
  User,
} from '@prisma/client';

import { PrismaService } from 'src/database/services/prisma.service';
import { AuditService } from 'src/modules/audit/audit.service';
import { DelivererPushService } from 'src/modules/deliverers/services/deliverer-push.service';

import {
  lireMembresDuPlanning,
  lireReposDuPlanning,
  planningQuiCouvre,
  plansEnCoursQuiChevauchent,
} from '../helpers/membres-planning';
import {
  actionAuJournal,
  type GestePlanning,
  MESSAGE_CONFIRMATION_HORS_ENVOYE,
  MESSAGE_DEJA_SUR_LE_PLANNING,
  MESSAGE_ENVOI_HORS_BROUILLON,
  MESSAGE_JOUR_HORS_PLANNING,
  MESSAGE_JOUR_SANS_REPOS,
  MESSAGE_LIVREUR_HORS_RESTAURANT,
  MESSAGE_LIVREUR_PAS_ACTIF,
  MESSAGE_PAS_SUR_LE_PLANNING,
  MESSAGE_PLANNING_CHANGE,
  MESSAGE_PLANNING_INTROUVABLE,
  messageChevauchement,
  messageJourDuPlanningEnCours,
  type NotificationPlanning,
  notificationDates,
  notificationJour,
  notificationRetrait,
  notificationSuppression,
  prevenirLesLivreurs,
  type ResumeJournal,
  resumeJournal,
} from '../helpers/planning.rules';
import {
  type IScheduleSettings,
  ScheduleSettingsHelper,
  type WeekDay,
} from '../helpers/schedule-settings.helper';

const WEEKDAY_NAMES: WeekDay[] = [
  'sunday',     // Date.getDay() = 0
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

const WEEKEND = new Set<WeekDay>(['saturday', 'sunday']);

/** Ordre naturel des jours (lundi d'abord) — pour trouver le 1er jour de repos autorisé. */
const ALL_WEEKDAYS: WeekDay[] = [
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
];

/**
 * Le compte qui agit et sa requête : sert au journal d'audit. Absent quand
 * c'est une tâche planifiée qui agit.
 */
export interface ActeurPlanning {
  user: User;
  method: string;
  path: string;
}

/** Planning lu avant un geste : son état décide qui prévenir et quoi noter. */
const SELECT_PLANNING = {
  id: true,
  restaurant_id: true,
  status: true,
  period_start: true,
  period_end: true,
  restaurant: { select: { name: true } },
} satisfies Prisma.SchedulePlanSelect;

type PlanningAvantGeste = Prisma.SchedulePlanGetPayload<{ select: typeof SELECT_PLANNING }>;

const SELECT_LIVREUR_NOMME = {
  id: true,
  first_name: true,
  last_name: true,
  genre: true,
} satisfies Prisma.DelivererSelect;

interface IGenerateInput {
  restaurantId: string;
  /** Date de début du plan (sera ramenée à 00:00 UTC). */
  periodStart: Date;
  /**
   * Date de fin du plan (incluse). Si non fournie, calculée comme
   * periodStart + planning_period_weeks - 1 jour.
   */
  periodEnd?: Date;
}

/**
 * Service de génération automatique des plans de planning (P7.2).
 *
 * Algorithme :
 *   1. Charger les settings et les livreurs ACTIVE du restaurant
 *   2. Pour chaque jour de la période, créer Shift(MORNING) + Shift(EVENING)
 *      avec `max_slots = default × volume_multiplier`
 *   3. Distribuer les jours de repos via rotation FIFO :
 *      - Solo → repos forcé sur `solo_deliverer_rest_day`
 *      - Multi → round-robin sur `weekday_rest_days_per_deliverer` jours/sem
 *   4. Pour chaque (livreur, shift) où le livreur n'est pas en repos :
 *      créer ShiftAssignment(ASSIGNED).
 *
 * Le plan est créé en `DRAFT` — l'admin doit l'envoyer (transition SEND).
 */
@Injectable()
export class SchedulePlanningService {
  private readonly logger = new Logger(SchedulePlanningService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: ScheduleSettingsHelper,
    // P-push livreur : push "Nouveau planning" quand le plan est envoyé
    private readonly pushService: DelivererPushService,
    // Ligne lisible au journal pour un planning archivé (24/10)
    private readonly audit: AuditService,
  ) {}

  /**
   * Génère un plan DRAFT pour un restaurant.
   * Renvoie le plan créé avec ses shifts + assignments.
   *
   * @throws BadRequestException si pas de livreur ACTIVE pour ce restaurant
   *   ou si la période est invalide
   */
  async generatePlan(input: IGenerateInput): Promise<SchedulePlan> {
    const settings = await this.settings.load();
    const periodStart = startOfDay(input.periodStart);
    const periodEnd = startOfDay(
      input.periodEnd ?? this.computePeriodEnd(periodStart, settings),
    );

    if (periodEnd < periodStart) {
      throw new BadRequestException('La date de fin ne peut pas précéder la date de début.');
    }

    // 0. Vérification de chevauchement avec un plan ACTIVE existant.
    //
    // Un plan ACTIVE = DRAFT/SENT/CONFIRMED (pas ARCHIVED). Si un tel plan
    // existe déjà sur tout ou partie de la nouvelle période pour ce restaurant,
    // on rejette : sinon le livreur recevrait 2 ShiftAssignments pour la
    // même date+type (un par plan), ce qui crée une UI confuse + des
    // RestDays incohérents + un cron deadline qui traite les 2 plans en parallèle.
    //
    // Sémantique d'overlap : `[a_start, a_end]` chevauche `[b_start, b_end]`
    // ssi `a_start <= b_end AND a_end >= b_start`.
    const overlapping = await this.prisma.schedulePlan.findFirst({
      where: {
        restaurant_id: input.restaurantId,
        status: { in: [SchedulePlanStatus.DRAFT, SchedulePlanStatus.SENT, SchedulePlanStatus.CONFIRMED] },
        period_start: { lte: periodEnd },
        period_end: { gte: periodStart },
      },
      select: { id: true, period_start: true, period_end: true, status: true },
    });
    if (overlapping) {
      throw new BadRequestException(messageChevauchement(overlapping));
    }

    // 1. Fetch livreurs candidats
    const deliverers = await this.prisma.deliverer.findMany({
      where: {
        restaurant_id: input.restaurantId,
        status: DelivererStatus.ACTIVE,
        entity_status: EntityStatus.ACTIVE,
      },
      orderBy: { created_at: 'asc' }, // ordre stable = équité rotation
      select: { id: true },
    });

    if (deliverers.length === 0) {
      throw new BadRequestException('Aucun livreur actif dans ce restaurant.');
    }

    // 2. Calculer les jours du plan + jours de repos par livreur
    const days = this.enumerateDays(periodStart, periodEnd);
    const restDayMap = this.computeRestDayDistribution(
      deliverers.map((d) => d.id),
      days,
      settings,
    );

    // 3. Créer le plan + shifts + assignments en transaction.
    //
    // **Optimisation perf** : on batch toutes les operations pour rester
    // bien sous le timeout transaction (5s par défaut). Avec une période de
    // 2 semaines × 2 shifts/jour × 5 livreurs, l'ancien code faisait ~57
    // queries séquentielles → timeout systématique sur Neon (latence ~50ms).
    //
    // Nouveau plan : 4 queries totales (plan, shifts, assignments, restDays)
    // grâce à `createManyAndReturn` (Prisma 6+).
    //
    // Le timeout est aussi explicitement étendu à 30s en filet de sécurité
    // pour les très grandes équipes (50+ livreurs).
    const plan = await this.prisma.$transaction(
      async (tx) => {
        const created = await tx.schedulePlan.create({
          data: {
            restaurant_id: input.restaurantId,
            period_start: periodStart,
            period_end: periodEnd,
            status: SchedulePlanStatus.DRAFT,
          },
        });

        // Pré-générer les data des shifts en mémoire
        const shiftsToCreate: {
          plan_id: string;
          date: Date;
          type: ShiftType;
          start_time: string;
          end_time: string;
          max_slots: number;
        }[] = [];
        for (const day of days) {
          const dayName = WEEKDAY_NAMES[day.getDay()];
          const isWeekend = WEEKEND.has(dayName);
          const volumeMultiplier = isWeekend
            ? settings.weekendVolumeMultiplier
            : settings.weekdayVolumeMultiplier;

          for (const shiftType of [ShiftType.MORNING, ShiftType.EVENING] as const) {
            const range =
              shiftType === ShiftType.MORNING ? settings.shiftMorning : settings.shiftEvening;
            const baseSlots =
              shiftType === ShiftType.MORNING
                ? settings.defaultSlotsMorning
                : settings.defaultSlotsEvening;
            const maxSlots = Math.max(1, Math.round(baseSlots * volumeMultiplier));

            shiftsToCreate.push({
              plan_id: created.id,
              date: day,
              type: shiftType,
              start_time: range.start,
              end_time: range.end,
              max_slots: maxSlots,
            });
          }
        }

        // 1 batch insert pour TOUS les shifts (au lieu de N queries séquentielles)
        const createdShifts = await tx.shift.createManyAndReturn({
          data: shiftsToCreate,
          select: { id: true, date: true, type: true },
        });

        // Préparer les assignments en mémoire (pour livreurs hors-repos)
        const assignmentsToCreate: {
          shift_id: string;
          deliverer_id: string;
          status: ShiftAssignmentStatus;
        }[] = [];
        for (const shift of createdShifts) {
          const dayKey = this.dateKey(shift.date);
          for (const d of deliverers) {
            const restSet = restDayMap.get(d.id) ?? new Set<string>();
            if (restSet.has(dayKey)) continue; // jour de repos → pas d'affectation
            assignmentsToCreate.push({
              shift_id: shift.id,
              deliverer_id: d.id,
              status: ShiftAssignmentStatus.ASSIGNED,
            });
          }
        }

        // 1 batch insert pour TOUS les assignments
        if (assignmentsToCreate.length > 0) {
          await tx.shiftAssignment.createMany({
            data: assignmentsToCreate,
            skipDuplicates: true,
          });
        }

        // 4. Aussi enregistrer les RestDay AUTO pour chaque livreur
        // Évite de re-deviner la rotation lors des consultations futures.
        const allRestDays: { deliverer_id: string; date: Date; source: RestDaySource }[] = [];
        for (const [delivererId, dayKeys] of restDayMap.entries()) {
          for (const key of dayKeys) {
            allRestDays.push({
              deliverer_id: delivererId,
              date: this.parseKey(key),
              source: RestDaySource.AUTO,
            });
          }
        }
        if (allRestDays.length > 0) {
          await tx.restDay.createMany({
            data: allRestDays,
            skipDuplicates: true,
          });
        }

        return created;
      },
      {
        // Filet de sécurité — la batch optimization devrait rester bien en
        // dessous, mais Neon peut avoir des hoquets de latence.
        timeout: 30_000,
        maxWait: 10_000,
      },
    );

    this.logger.log(
      `Plan ${plan.id.slice(0, 8)} généré : ${days.length} jours × 2 shifts, ` +
        `${deliverers.length} livreur(s), restaurant ${input.restaurantId.slice(0, 8)}`,
    );

    return plan;
  }

  /**
   * Ajout INCRÉMENTAL d'un livreur à un plan existant (cas : un livreur est
   * rattaché au restaurant APRÈS la génération du plan). On PRÉSERVE le plan et
   * toutes les affectations/confirmations existantes — on n'ajoute QUE le nouveau
   * livreur à ses shifts (hors ses jours de repos, calculés indépendamment).
   *
   * Permis dans les quatre états (24/10). Envoyé ou confirmé : le livreur
   * reçoit « Nouveau planning ». Archivé : ligne au journal, et aucun repos
   * posé sur les jours d'un planning en cours du restaurant (ils sont à lui).
   */
  async addDelivererToPlan(
    planId: string,
    delivererId: string,
    acteur?: ActeurPlanning,
  ): Promise<{ added: number }> {
    const plan = await this.lirePlanning(planId);

    // Le livreur doit être ACTIVE et rattaché au restaurant du plan.
    const deliverer = await this.prisma.deliverer.findFirst({
      where: {
        id: delivererId,
        restaurant_id: plan.restaurant_id,
        status: DelivererStatus.ACTIVE,
        entity_status: EntityStatus.ACTIVE,
      },
      select: SELECT_LIVREUR_NOMME,
    });
    if (!deliverer) throw new BadRequestException(MESSAGE_LIVREUR_PAS_ACTIF);

    // Déjà sur ce planning (une affectation, ou des repos du planning) ? → refus.
    const membres = await lireMembresDuPlanning(this.prisma, plan);
    if (membres.includes(delivererId)) {
      throw new BadRequestException(MESSAGE_DEJA_SUR_LE_PLANNING);
    }

    // Shifts du plan + jours de repos du NOUVEAU livreur (rotation calculée pour lui
    // seul → n'altère pas la distribution des livreurs déjà planifiés).
    const shifts = await this.prisma.shift.findMany({
      where: { plan_id: planId },
      select: { id: true, date: true },
    });
    const settings = await this.settings.load();
    const days = this.enumerateDays(plan.period_start, plan.period_end);
    const restSet =
      this.computeRestDayDistribution([delivererId], days, settings).get(delivererId) ??
      new Set<string>();

    const assignments = shifts
      .filter((s) => !restSet.has(this.dateKey(s.date)))
      .map((s) => ({
        shift_id: s.id,
        deliverer_id: delivererId,
        status: ShiftAssignmentStatus.ASSIGNED,
      }));
    const enCours = await plansEnCoursQuiChevauchent(this.prisma, plan);
    const restDays = [...restSet]
      .map((key) => ({
        deliverer_id: delivererId,
        date: this.parseKey(key),
        source: RestDaySource.AUTO,
      }))
      .filter((r) => !planningQuiCouvre(enCours, r.date));

    await this.prisma.$transaction(async (tx) => {
      if (assignments.length > 0) {
        await tx.shiftAssignment.createMany({ data: assignments, skipDuplicates: true });
      }
      if (restDays.length > 0) {
        await tx.restDay.createMany({ data: restDays, skipDuplicates: true });
      }
    });

    // Plan déjà envoyé/confirmé → prévenir le nouveau livreur qu'il a un planning.
    if (prevenirLesLivreurs(plan.status)) {
      this.pushService.notifyPlanSent({
        delivererId,
        periodStart: plan.period_start.toISOString().substring(0, 10),
        periodEnd: plan.period_end.toISOString().substring(0, 10),
        planId,
      });
    }
    this.noterAuJournal(plan, 'ajout', acteur, { geste: 'ajout', livreur: deliverer }, { delivererId });

    this.logger.log(
      `Livreur ${delivererId.slice(0, 8)} ajouté au plan ${planId.slice(0, 8)} : ${assignments.length} shift(s).`,
    );
    return { added: assignments.length };
  }

  /**
   * Retire un livreur d'un planning, dans les quatre états (24/10) : ses
   * affectations du planning et ses repos `AUTO` et `MANUAL_ADMIN` de la
   * période sont effacés. Les repos qu'il a posés lui-même restent, comme
   * ceux qu'un autre planning garde (`GardeDesRepos`, cas `'en_cours'`) :
   * planning de son nouveau restaurant, planning en cours quand on retire
   * d'un archivé.
   *
   * Envoyé ou confirmé : il est prévenu. Archivé : ligne au journal.
   */
  async removeDelivererFromPlan(
    planId: string,
    delivererId: string,
    acteur?: ActeurPlanning,
  ): Promise<{ removed: number }> {
    const plan = await this.lirePlanning(planId);
    const membres = await lireMembresDuPlanning(this.prisma, plan);
    if (!membres.includes(delivererId)) throw new BadRequestException(MESSAGE_PAS_SUR_LE_PLANNING);

    const deliverer = await this.prisma.deliverer.findUnique({
      where: { id: delivererId },
      select: SELECT_LIVREUR_NOMME,
    });

    const { libres } = await lireReposDuPlanning(this.prisma, plan, { deliverer_id: delivererId }, 'en_cours');

    const [affectations, repos] = await this.prisma.$transaction([
      this.prisma.shiftAssignment.deleteMany({
        where: { deliverer_id: delivererId, shift: { plan_id: planId } },
      }),
      this.prisma.restDay.deleteMany({ where: { id: { in: libres.map((r) => r.id) } } }),
    ]);
    // Une autre requête l'a retiré entre-temps : rien à annoncer une seconde fois.
    if (affectations.count === 0 && repos.count === 0) {
      throw new ConflictException(MESSAGE_PLANNING_CHANGE);
    }

    this.prevenir(plan, [delivererId], notificationRetrait(plan));
    this.noterAuJournal(plan, 'retrait', acteur, { geste: 'retrait', livreur: deliverer }, { delivererId });

    this.logger.log(
      `Livreur ${delivererId.slice(0, 8)} retiré du plan ${planId.slice(0, 8)} : ` +
        `${affectations.count} affectation(s), ${repos.count} repos.`,
    );
    return { removed: affectations.count };
  }

  /**
   * Livreurs actifs du restaurant du planning qui n'y sont pas encore : la
   * liste de la fenêtre « Ajouter un livreur ».
   */
  async livreursAjoutables(planId: string) {
    const plan = await this.lirePlanning(planId);
    const membres = await lireMembresDuPlanning(this.prisma, plan);
    return this.prisma.deliverer.findMany({
      where: {
        restaurant_id: plan.restaurant_id,
        status: DelivererStatus.ACTIVE,
        entity_status: EntityStatus.ACTIVE,
        id: { notIn: membres },
      },
      select: { id: true, first_name: true, last_name: true, image: true },
      orderBy: [{ first_name: 'asc' }, { last_name: 'asc' }],
    });
  }

  /**
   * Transition DRAFT → SENT : verrouille le plan, démarre la deadline d'acceptation.
   * À ce stade, les shifts sont visibles côté livreur mobile.
   *
   * Prise atomique : un double envoi ne prévient pas deux fois les livreurs.
   *
   * @throws BadRequestException si le plan n'est pas en DRAFT
   * @throws NotFoundException si le plan n'existe pas
   */
  async sendPlan(planId: string): Promise<SchedulePlan> {
    const pris = await this.prisma.schedulePlan.updateMany({
      where: { id: planId, status: SchedulePlanStatus.DRAFT },
      data: { status: SchedulePlanStatus.SENT, sent_at: new Date() },
    });
    if (pris.count !== 1) {
      await this.lirePlanning(planId);
      throw new BadRequestException(MESSAGE_ENVOI_HORS_BROUILLON);
    }
    const updated = await this.prisma.schedulePlan.findUniqueOrThrow({ where: { id: planId } });

    // P-push livreur : alerter chaque livreur ayant des assignments dans ce plan.
    // On bouble en interne sur les delivererId distincts.
    const delivererIds = await this.prisma.shiftAssignment.findMany({
      where: { shift: { plan_id: planId } },
      select: { deliverer_id: true },
      distinct: ['deliverer_id'],
    });
    const periodStart = updated.period_start.toISOString().substring(0, 10);
    const periodEnd = updated.period_end.toISOString().substring(0, 10);
    for (const { deliverer_id } of delivererIds) {
      this.pushService.notifyPlanSent({
        delivererId: deliverer_id,
        periodStart,
        periodEnd,
        planId: updated.id,
      });
    }

    return updated;
  }

  /**
   * Marque un plan comme CONFIRMED (toutes les réponses collectées ou deadline
   * passée). Le snapshot `confirmed_count` est calculé ici.
   *
   * Prise atomique sur l'état SENT : la tâche `closeOverduePlans` et un clic
   * au même moment ne confirment qu'une fois.
   */
  async confirmPlan(planId: string): Promise<SchedulePlan> {
    const plan = await this.prisma.schedulePlan.findUnique({
      where: { id: planId },
      include: {
        shifts: { include: { assignments: true } },
      },
    });
    if (!plan) throw new NotFoundException(MESSAGE_PLANNING_INTROUVABLE);
    if (plan.status !== SchedulePlanStatus.SENT) {
      throw new BadRequestException(MESSAGE_CONFIRMATION_HORS_ENVOYE);
    }

    const allAssignments = plan.shifts.flatMap((s) => s.assignments);
    const confirmedCount = new Set(
      allAssignments
        .filter((a) => a.status === ShiftAssignmentStatus.CONFIRMED)
        .map((a) => a.deliverer_id),
    ).size;

    const pris = await this.prisma.schedulePlan.updateMany({
      where: { id: planId, status: SchedulePlanStatus.SENT },
      data: {
        status: SchedulePlanStatus.CONFIRMED,
        confirmed_at: new Date(),
        confirmed_count: confirmedCount,
      },
    });
    if (pris.count !== 1) throw new ConflictException(MESSAGE_PLANNING_CHANGE);
    return this.prisma.schedulePlan.findUniqueOrThrow({ where: { id: planId } });
  }

  /**
   * Archive un plan (libère l'espace de la matrice UI). Depuis tout état non
   * archivé, comme avant. Idempotent : un planning déjà archivé est rendu tel
   * quel, sans toucher à sa date d'archivage (la tâche `archiveOldPlans` peut
   * passer deux fois).
   */
  async archivePlan(planId: string): Promise<SchedulePlan> {
    await this.prisma.schedulePlan.updateMany({
      where: { id: planId, status: { not: SchedulePlanStatus.ARCHIVED } },
      data: { status: SchedulePlanStatus.ARCHIVED, archived_at: new Date() },
    });
    const plan = await this.prisma.schedulePlan.findUnique({ where: { id: planId } });
    if (!plan) throw new NotFoundException(MESSAGE_PLANNING_INTROUVABLE);
    return plan;
  }

  /**
   * Supprime DÉFINITIVEMENT un plan (et, par cascade, ses Shifts + ShiftAssignments),
   * dans les quatre états (24/10).
   *
   * - Les livreurs à prévenir sont lus AVANT la suppression : envoyé ou
   *   confirmé, chacun reçoit « Planning annulé ».
   * - Confirmé ou archivé : ligne au journal.
   * - Les repos `AUTO` et `MANUAL_ADMIN` de ses livreurs dans sa période
   *   partent avec lui (le livreur ne les voit plus, et un planning refait
   *   pour ces dates repart propre), sauf les jours couverts par un autre
   *   planning du restaurant.
   */
  async deletePlan(planId: string, acteur?: ActeurPlanning): Promise<{ id: string; deleted: true }> {
    const plan = await this.lirePlanning(planId);
    const membres = await lireMembresDuPlanning(this.prisma, plan);
    const reposAEffacer = await this.reposDuPlanningAEffacer(plan, membres);

    await this.prisma.$transaction(async (tx) => {
      const supprime = await tx.schedulePlan.deleteMany({
        where: { id: planId, status: plan.status },
      });
      if (supprime.count !== 1) throw new ConflictException(MESSAGE_PLANNING_CHANGE);
      if (reposAEffacer.length > 0) {
        await tx.restDay.deleteMany({ where: { id: { in: reposAEffacer.map((r) => r.id) } } });
      }
    });

    this.prevenir(plan, membres, notificationSuppression(plan));
    this.noterAuJournal(plan, 'suppression', acteur, { geste: 'suppression' });

    this.logger.log(`Plan ${planId.slice(0, 8)} supprimé (statut ${plan.status})`);
    return { id: planId, deleted: true };
  }

  /**
   * ÉDITION d'un jour : bascule un (livreur, jour) entre REPOS et TRAVAIL,
   * en gardant la matrice cohérente (RestDay + ShiftAssignment).
   *
   * - `REST` : pose un RestDay MANUAL_ADMIN + retire les assignments du jour.
   *   Refusé si le jour est dans `no_rest_days` (le restaurant respecte la règle métier).
   * - `WORK` : retire le RestDay + (re)crée les assignments matin/soir du jour,
   *   en ASSIGNED : le livreur confirme, même sur un planning confirmé.
   *
   * Permis dans les quatre états (24/10). Si le jour change vraiment : envoyé
   * ou confirmé, le livreur est prévenu ; archivé, ligne au journal. Sur un
   * archivé, refus pour un jour qu'un planning en cours du restaurant couvre
   * aussi : le repos de ce jour est le sien.
   */
  async setDelivererDayMode(
    planId: string,
    delivererId: string,
    dateInput: Date,
    mode: 'REST' | 'WORK',
    acteur?: ActeurPlanning,
  ): Promise<SchedulePlan> {
    const plan = await this.lirePlanning(planId);

    const day = startOfDay(dateInput);
    if (day < startOfDay(plan.period_start) || day > startOfDay(plan.period_end)) {
      throw new BadRequestException(MESSAGE_JOUR_HORS_PLANNING);
    }

    // Le livreur doit appartenir au restaurant du plan et être ACTIF.
    const deliverer = await this.prisma.deliverer.findFirst({
      where: {
        id: delivererId,
        restaurant_id: plan.restaurant_id,
        status: DelivererStatus.ACTIVE,
      },
      select: SELECT_LIVREUR_NOMME,
    });
    if (!deliverer) throw new BadRequestException(MESSAGE_LIVREUR_HORS_RESTAURANT);

    const enCours = planningQuiCouvre(await plansEnCoursQuiChevauchent(this.prisma, plan), day);
    if (enCours) throw new BadRequestException(messageJourDuPlanningEnCours(enCours));

    let change: boolean;
    if (mode === 'REST') {
      // Le restaurant respecte la règle : pas de repos sur les jours interdits.
      const settings = await this.settings.load();
      const dayName = WEEKDAY_NAMES[day.getUTCDay()];
      if (new Set<WeekDay>(settings.noRestDays).has(dayName)) {
        throw new BadRequestException(MESSAGE_JOUR_SANS_REPOS);
      }
      const reposAvant = await this.prisma.restDay.findUnique({
        where: { deliverer_id_date: { deliverer_id: delivererId, date: day } },
        select: { id: true },
      });
      const [, retirees] = await this.prisma.$transaction([
        this.prisma.restDay.upsert({
          where: { deliverer_id_date: { deliverer_id: delivererId, date: day } },
          update: { source: RestDaySource.MANUAL_ADMIN },
          create: { deliverer_id: delivererId, date: day, source: RestDaySource.MANUAL_ADMIN },
        }),
        this.prisma.shiftAssignment.deleteMany({
          where: { deliverer_id: delivererId, shift: { plan_id: planId, date: day } },
        }),
      ]);
      change = retirees.count > 0 || !reposAvant;
    } else {
      const shifts = await this.prisma.shift.findMany({
        where: { plan_id: planId, date: day },
        select: { id: true },
      });
      const [reposRetires, creees] = await this.prisma.$transaction([
        this.prisma.restDay.deleteMany({ where: { deliverer_id: delivererId, date: day } }),
        this.prisma.shiftAssignment.createMany({
          data: shifts.map((s) => ({
            shift_id: s.id,
            deliverer_id: delivererId,
            status: ShiftAssignmentStatus.ASSIGNED,
          })),
          skipDuplicates: true,
        }),
      ]);
      change = reposRetires.count > 0 || creees.count > 0;
    }

    if (change) {
      this.prevenir(plan, [delivererId], notificationJour(mode, day));
      this.noterAuJournal(
        plan,
        'jour',
        acteur,
        { geste: 'jour', livreur: deliverer, mode, date: day },
        { delivererId, date: this.dateKey(day), mode },
      );
    }

    this.logger.log(
      `Plan ${planId.slice(0, 8)} : livreur ${delivererId.slice(0, 8)} → ${mode} le ${this.dateKey(day)}`,
    );
    return this.prisma.schedulePlan.findUniqueOrThrow({ where: { id: planId } });
  }

  /**
   * Réédite les DATES d'un plan : régénère un plan DRAFT pour la nouvelle
   * période (mêmes règles : repos no_rest_days, etc.), puis supprime l'ancien.
   * En cas d'échec de génération, l'ancien plan est RESTAURÉ → aucune perte de données.
   *
   * Permis dans les quatre états (24/10) : le planning repart en brouillon et
   * les réponses des livreurs sont effacées. Le contrôle de chevauchement de
   * `generatePlan` reste la garde. Envoyé ou confirmé : ses livreurs sont
   * prévenus ; archivé : ligne au journal.
   */
  async regeneratePlan(
    planId: string,
    periodStart: Date,
    periodEnd?: Date,
    acteur?: ActeurPlanning,
  ): Promise<SchedulePlan> {
    const plan = await this.lirePlanning(planId);
    const previousStatus = plan.status;
    const dejaArchive = previousStatus === SchedulePlanStatus.ARCHIVED;
    const membres = await lireMembresDuPlanning(this.prisma, plan);

    // Archive temporaire : libère l'overlap-check + l'index unique le temps de
    // régénérer. Prise atomique : deux rééditions en même temps n'en font qu'une.
    // Un planning déjà archivé ne gêne ni l'un ni l'autre.
    if (!dejaArchive) {
      const pris = await this.prisma.schedulePlan.updateMany({
        where: { id: planId, status: previousStatus },
        data: { status: SchedulePlanStatus.ARCHIVED, archived_at: new Date() },
      });
      if (pris.count !== 1) throw new ConflictException(MESSAGE_PLANNING_CHANGE);
    }

    // Repos de l'ancien planning : effacés pour que le nouveau parte de sa
    // propre rotation, remis tels quels si la génération échoue.
    const reposAEffacer = await this.reposDuPlanningAEffacer(plan, membres);

    try {
      if (reposAEffacer.length > 0) {
        await this.prisma.restDay.deleteMany({ where: { id: { in: reposAEffacer.map((r) => r.id) } } });
      }
      const fresh = await this.generatePlan({
        restaurantId: plan.restaurant_id,
        periodStart,
        periodEnd,
      });
      // Génération OK → l'ancien plan (archivé) est supprimé.
      await this.prisma.schedulePlan.deleteMany({ where: { id: planId } });

      this.prevenir(plan, membres, notificationDates(plan));
      this.noterAuJournal(
        plan,
        'dates',
        acteur,
        { geste: 'dates', debut: fresh.period_start, fin: fresh.period_end },
        { nouveauPlanningId: fresh.id },
      );

      this.logger.log(
        `Plan ${planId.slice(0, 8)} réédité → nouveau plan ${fresh.id.slice(0, 8)}`,
      );
      return fresh;
    } catch (err) {
      // Échec → RESTAURE l'ancien plan dans son état initial (aucune perte).
      if (reposAEffacer.length > 0) {
        await this.prisma.restDay.createMany({
          data: reposAEffacer.map(({ deliverer_id, date, source, reason }) => ({
            deliverer_id,
            date,
            source,
            reason,
          })),
          skipDuplicates: true,
        });
      }
      if (!dejaArchive) {
        await this.prisma.schedulePlan.updateMany({
          where: { id: planId, status: SchedulePlanStatus.ARCHIVED },
          data: { status: previousStatus, archived_at: null },
        });
      }
      throw err;
    }
  }

  // ============================================================
  // GESTES : LECTURE, NOTIFICATIONS, JOURNAL
  // ============================================================

  /** Le planning avant un geste, avec le nom de son restaurant. 404 s'il n'existe plus. */
  private async lirePlanning(planId: string): Promise<PlanningAvantGeste> {
    const plan = await this.prisma.schedulePlan.findUnique({
      where: { id: planId },
      select: SELECT_PLANNING,
    });
    if (!plan) throw new NotFoundException(MESSAGE_PLANNING_INTROUVABLE);
    return plan;
  }

  /**
   * Repos `AUTO` et `MANUAL_ADMIN` des livreurs d'un planning, dans sa période,
   * hors des jours qu'un autre planning garde (`GardeDesRepos`, cas `'tous'`) :
   * tout autre planning du restaurant, et le planning d'un autre restaurant
   * qui est celui du livreur ou qui l'a dans ses affectations.
   */
  private async reposDuPlanningAEffacer(plan: PlanningAvantGeste, membres: string[]) {
    if (membres.length === 0) return [];
    const { libres } = await lireReposDuPlanning(this.prisma, plan, { deliverer_id: { in: membres } }, 'tous');
    return libres;
  }

  /** Une notification par livreur, seulement sur un planning envoyé ou confirmé. */
  private prevenir(plan: PlanningAvantGeste, livreurs: string[], notification: NotificationPlanning): void {
    if (!prevenirLesLivreurs(plan.status)) return;
    for (const delivererId of livreurs) {
      this.pushService.notifyPlanModifie({ delivererId, planId: plan.id, ...notification });
    }
  }

  /**
   * Ligne lisible au journal d'audit (planning archivé, suppression d'un
   * planning confirmé), en plus de celle que l'intercepteur écrit pour toute
   * modification. Rien sans compte connecté (tâche planifiée).
   */
  private noterAuJournal(
    plan: PlanningAvantGeste,
    geste: GestePlanning,
    acteur: ActeurPlanning | undefined,
    resume: ResumeJournal,
    metadata?: Prisma.InputJsonValue,
  ): void {
    const action = actionAuJournal(plan.status, geste);
    if (!action || !acteur) return;
    this.audit.record({
      actor_id: acteur.user.id,
      actor_name: acteur.user.fullname ?? acteur.user.email ?? null,
      actor_role: acteur.user.role,
      restaurant_id: plan.restaurant_id,
      action,
      module: 'schedule',
      entity_id: plan.id,
      method: acteur.method,
      path: acteur.path,
      summary: resumeJournal(plan, resume),
      ...(metadata !== undefined ? { metadata } : {}),
    });
  }

  // ============================================================
  // ALGORITHMES INTERNES
  // ============================================================

  /**
   * Distribue les jours de repos via une rotation déterministe :
   *   - 1 livreur seul → repos forcé sur `solo_deliverer_rest_day`
   *   - N livreurs    → round-robin par index (livreur i, semaine s) :
   *     `restDayIndex = (i + s × repos_par_semaine) mod nbWeekdays`
   *
   * Garantit l'équité sur `rotation_cycle_weeks` semaines : chaque livreur
   * passe par tous les jours possibles. Les jours INTERDITS de repos
   * (`no_rest_days`, défaut vendredi/samedi/dimanche) sont toujours exclus.
   */
  private computeRestDayDistribution(
    delivererIds: string[],
    days: Date[],
    settings: IScheduleSettings,
  ): Map<string, Set<string>> {
    const result = new Map<string, Set<string>>();
    delivererIds.forEach((id) => result.set(id, new Set<string>()));

    if (delivererIds.length === 0) return result;

    // Jours INTERDITS de repos (forte activité) — défaut vendredi/samedi/dimanche.
    const noRestDays = new Set<WeekDay>(settings.noRestDays);

    // Cas particulier : 1 seul livreur → repos forcé sur soloDelivererRestDay,
    // SAUF si ce jour est interdit → fallback sur le 1er jour autorisé (lun→jeu).
    if (delivererIds.length === 1) {
      const soloRestDay: WeekDay = noRestDays.has(settings.soloDelivererRestDay)
        ? (ALL_WEEKDAYS.find((d) => !noRestDays.has(d)) ?? 'monday')
        : settings.soloDelivererRestDay;
      const restSet = result.get(delivererIds[0])!;
      for (const day of days) {
        const dayName = WEEKDAY_NAMES[day.getDay()];
        if (dayName === soloRestDay) {
          restSet.add(this.dateKey(day));
        }
      }
      return result;
    }

    // Cas multi-livreurs : grouper les jours par semaine (jours interdits exclus).
    const weeks = this.groupByWeek(days, noRestDays);
    weeks.forEach((weekDays, weekIndex) => {
      delivererIds.forEach((delivererId, deliverIndex) => {
        // Combien de jours de repos pour ce livreur cette semaine
        const restDaysCount = settings.weekdayRestDaysPerDeliverer;

        // Round-robin : décale chaque livreur d'une position par semaine
        const restSet = result.get(delivererId)!;
        for (let r = 0; r < restDaysCount && weekDays.length > 0; r++) {
          const offset = (deliverIndex + weekIndex + r * delivererIds.length) % weekDays.length;
          restSet.add(this.dateKey(weekDays[offset]));
        }
      });
    });

    return result;
  }

  private groupByWeek(days: Date[], noRestDays: Set<WeekDay>): Date[][] {
    const result: Date[][] = [];
    let currentWeek: Date[] = [];
    for (const day of days) {
      const dayName = WEEKDAY_NAMES[day.getDay()];
      // Exclure les jours INTERDITS de repos : non éligibles à la rotation.
      if (noRestDays.has(dayName)) continue;

      // Nouveau lundi → nouvelle semaine
      if (currentWeek.length > 0 && day.getDay() === 1) {
        result.push(currentWeek);
        currentWeek = [];
      }
      currentWeek.push(day);
    }
    if (currentWeek.length > 0) result.push(currentWeek);
    return result;
  }

  private enumerateDays(start: Date, end: Date): Date[] {
    const days: Date[] = [];
    const cursor = new Date(start);
    while (cursor <= end) {
      days.push(new Date(cursor));
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return days;
  }

  private computePeriodEnd(start: Date, settings: IScheduleSettings): Date {
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + settings.planningPeriodWeeks * 7 - 1);
    return end;
  }

  private dateKey(d: Date): string {
    return d.toISOString().substring(0, 10); // YYYY-MM-DD
  }

  private parseKey(key: string): Date {
    return startOfDay(new Date(`${key}T00:00:00.000Z`));
  }
}

// ============================================================
// HELPERS PURS
// ============================================================

function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setUTCHours(0, 0, 0, 0);
  return out;
}
