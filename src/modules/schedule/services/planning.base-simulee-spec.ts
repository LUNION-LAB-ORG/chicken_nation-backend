/**
 * Base en mémoire pour les tests du planning (contrôleur, services et tâches
 * planifiées RÉELS).
 *
 * Les `where` reçus sont ÉVALUÉS (AND, OR, NOT, null, not, in, notIn,
 * comparaisons, filtres de relation) : retirer une condition d'une écriture
 * conditionnée (l'état attendu d'une prise atomique, le restaurant d'un
 * livreur, l'origine d'un repos) fait casser le test qui la porte. Les
 * relations sont lues à la volée, et `select` et `include` ne rendent que ce
 * qu'ils demandent.
 *
 * Contraintes reprises de la base : un livreur une seule fois par créneau, un
 * repos par livreur et par jour, un seul planning non archivé par restaurant
 * et date de début (index unique partiel), suppression en cascade d'un
 * planning vers ses créneaux et leurs affectations.
 *
 * Fichier de test seulement. Son nom finit par « -spec.ts » : exclu de la
 * construction sans être lancé comme une suite par jest.
 */
import {
  DelivererStatus,
  EntityStatus,
  Genre,
  RestDaySource,
  SchedulePlanStatus,
  ShiftAssignmentStatus,
  ShiftType,
  User,
  UserRole,
  UserType,
} from '@prisma/client';

import { ScheduleAdminController } from '../controllers/schedule-admin.controller';
import type { IScheduleSettings } from '../helpers/schedule-settings.helper';
import { ScheduleTask } from '../tasks/schedule.task';
import { SchedulePlanningService } from './schedule-planning.service';
import { ScheduleQueryService } from './schedule-query.service';

export type Ligne = Record<string, any>;

const egal = (a: unknown, b: unknown) =>
  a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b;

const OPERATEURS = ['not', 'in', 'notIn', 'gte', 'gt', 'lt', 'lte', 'equals'];

export function correspond(ligne: Ligne | null | undefined, where: Ligne | undefined): boolean {
  if (!where) return true;
  if (!ligne) return false;
  for (const [cle, condition] of Object.entries(where)) {
    if (condition === undefined) continue;
    if (cle === 'AND') {
      const liste = Array.isArray(condition) ? condition : [condition];
      if (!liste.every((c) => correspond(ligne, c))) return false;
      continue;
    }
    if (cle === 'OR') {
      if (!(condition as Ligne[]).some((c) => correspond(ligne, c))) return false;
      continue;
    }
    if (cle === 'NOT') {
      const liste = Array.isArray(condition) ? condition : [condition];
      if (liste.some((c) => correspond(ligne, c))) return false;
      continue;
    }
    const valeur = ligne[cle];
    if (condition === null) {
      if (valeur !== null && valeur !== undefined) return false;
      continue;
    }
    if (condition instanceof Date || typeof condition !== 'object') {
      if (!egal(valeur, condition)) return false;
      continue;
    }
    const c = condition as Ligne;
    if (Object.keys(c).some((k) => OPERATEURS.includes(k))) {
      if ('equals' in c && !egal(valeur, c.equals)) return false;
      if ('not' in c && (c.not === null ? valeur == null : egal(valeur, c.not))) return false;
      if ('in' in c && !(c.in as unknown[]).some((v) => egal(v, valeur))) return false;
      if ('notIn' in c && (c.notIn as unknown[]).some((v) => egal(v, valeur))) return false;
      if ('gte' in c && !(valeur != null && valeur >= c.gte)) return false;
      if ('gt' in c && !(valeur != null && valeur > c.gt)) return false;
      if ('lt' in c && !(valeur != null && valeur < c.lt)) return false;
      if ('lte' in c && !(valeur != null && valeur <= c.lte)) return false;
      continue;
    }
    if (!correspond(valeur, c)) return false;
  }
  return true;
}

function projeter(ligne: Ligne, args: Ligne = {}): Ligne {
  if (args.select) {
    const out: Ligne = {};
    for (const [k, v] of Object.entries(args.select)) {
      if (!v) continue;
      out[k] = v === true ? relation(ligne[k], {}) : relation(ligne[k], v as Ligne);
    }
    return out;
  }
  const out: Ligne = { ...ligne };
  for (const [k, v] of Object.entries(args.include ?? {})) {
    if (!v) continue;
    out[k] = relation(ligne[k], v === true ? {} : (v as Ligne));
  }
  return out;
}

function relation(valeur: unknown, args: Ligne): unknown {
  if (Array.isArray(valeur)) {
    return valeur.filter((x) => correspond(x, args.where)).map((x) => projeter(x, args));
  }
  if (valeur && typeof valeur === 'object' && !(valeur instanceof Date)) return projeter(valeur as Ligne, args);
  return valeur;
}

function trier(lignes: Ligne[], orderBy: unknown): Ligne[] {
  const regles = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []).flatMap((o: Ligne) =>
    Object.entries(o).filter(([, sens]) => typeof sens === 'string'),
  ) as [string, 'asc' | 'desc'][];
  return [...lignes].sort((a, b) => {
    for (const [champ, sens] of regles) {
      const x = a[champ];
      const y = b[champ];
      if (x === y) continue;
      const r = x == null ? -1 : y == null ? 1 : x < y ? -1 : x > y ? 1 : 0;
      if (r !== 0) return sens === 'desc' ? -r : r;
    }
    return 0;
  });
}

function distinctes(lignes: Ligne[], champs?: string[]): Ligne[] {
  if (!champs?.length) return lignes;
  const vues = new Set<string>();
  return lignes.filter((l) => {
    const cle = champs.map((c) => String(l[c])).join('|');
    if (vues.has(cle)) return false;
    vues.add(cle);
    return true;
  });
}

/** Clés uniques composées (`deliverer_id_date`) mises à plat pour l'évaluation. */
function aPlat(where: Ligne): Ligne {
  const out: Ligne = {};
  for (const [k, v] of Object.entries(where)) {
    if (k === 'deliverer_id_date') Object.assign(out, v);
    else out[k] = v;
  }
  return out;
}

const lier = (ligne: Ligne, relations: Record<string, () => unknown>): Ligne => {
  for (const [k, f] of Object.entries(relations)) {
    Object.defineProperty(ligne, k, { get: f, enumerable: false, configurable: true });
  }
  return ligne;
};

export const RESTO_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const RESTO_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

export const KOFFI = '11111111-0000-4000-8000-000000000001';
export const ALI = '11111111-0000-4000-8000-000000000002';
export const AWA = '11111111-0000-4000-8000-000000000003';
export const SUSPENDU = '11111111-0000-4000-8000-000000000004';
export const LIVREUR_B = '11111111-0000-4000-8000-000000000005';

export const ADMIN = { id: 'admin', fullname: 'Admin Siège', email: 'admin@cn.ci', role: UserRole.ADMIN, type: UserType.BACKOFFICE, restaurant_id: null } as unknown as User;
export const OPS = { id: 'ops', fullname: 'Suivi', email: 'ops@cn.ci', role: UserRole.LIVRAISON_OPS, type: UserType.BACKOFFICE, restaurant_id: null } as unknown as User;
export const MANAGER_A = { id: 'manager-a', fullname: 'Manager Angré', email: 'a@cn.ci', role: UserRole.MANAGER, type: UserType.RESTAURANT, restaurant_id: RESTO_A } as unknown as User;
export const MANAGER_B = { id: 'manager-b', fullname: 'Manager Marcory', email: 'b@cn.ci', role: UserRole.MANAGER, type: UserType.RESTAURANT, restaurant_id: RESTO_B } as unknown as User;

export const jour = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

export const REGLAGES: IScheduleSettings = {
  planningPeriodWeeks: 2,
  rotationCycleWeeks: 4,
  weekdayRestDaysPerDeliverer: 1,
  weekendRestAllowed: false,
  noRestDays: ['friday', 'saturday', 'sunday'],
  soloDelivererRestDay: 'monday',
  allowRestDayOverride: true,
  shiftMorning: { start: '09:00', end: '15:00' },
  shiftEvening: { start: '15:00', end: '23:00' },
  defaultSlotsMorning: 3,
  defaultSlotsEvening: 3,
  enforceSlots: false,
  weekdayVolumeMultiplier: 1,
  weekendVolumeMultiplier: 1.5,
  acceptanceDeadlineHours: 48,
  autoSendDayOfWeek: 5,
  autoSendHour: 18,
  dailyPresenceCheckHour: 8,
};

export function monterBase() {
  let numero = 0;
  const nouvelId = () => `99999999-0000-4000-8000-${String(++numero).padStart(12, '0')}`;

  const db = {
    restaurants: [] as Ligne[],
    deliverers: [] as Ligne[],
    plans: [] as Ligne[],
    shifts: [] as Ligne[],
    assignments: [] as Ligne[],
    restDays: [] as Ligne[],
  };

  const ajouterPlan = (data: Ligne): Ligne => {
    const conflit = db.plans.find(
      (p) =>
        p.restaurant_id === data.restaurant_id &&
        egal(p.period_start, data.period_start) &&
        p.status !== SchedulePlanStatus.ARCHIVED &&
        data.status !== SchedulePlanStatus.ARCHIVED,
    );
    if (conflit) throw new Error('Index unique partiel (restaurant_id, period_start) violé');
    const p = lier(
      {
        id: nouvelId(),
        confirmed_count: 0,
        sent_at: null,
        confirmed_at: null,
        archived_at: null,
        entity_status: EntityStatus.ACTIVE,
        created_at: new Date(),
        updated_at: new Date(),
        status: SchedulePlanStatus.DRAFT,
        ...data,
      },
      {
        restaurant: () => db.restaurants.find((r) => r.id === p.restaurant_id),
        shifts: () => db.shifts.filter((s) => s.plan_id === p.id),
      },
    );
    db.plans.push(p);
    return p;
  };

  const ajouterShift = (data: Ligne): Ligne => {
    const s = lier(
      { id: nouvelId(), entity_status: EntityStatus.ACTIVE, ...data },
      {
        plan: () => db.plans.find((p) => p.id === s.plan_id),
        assignments: () => db.assignments.filter((a) => a.shift_id === s.id),
      },
    );
    db.shifts.push(s);
    return s;
  };

  const ajouterAffectation = (data: Ligne): Ligne | null => {
    if (db.assignments.some((a) => a.shift_id === data.shift_id && a.deliverer_id === data.deliverer_id)) return null;
    const a = lier(
      {
        id: nouvelId(),
        status: ShiftAssignmentStatus.ASSIGNED,
        confirmed_at: null,
        refused_at: null,
        refusal_reason: null,
        ...data,
      },
      {
        shift: () => db.shifts.find((s) => s.id === a.shift_id),
        deliverer: () => db.deliverers.find((d) => d.id === a.deliverer_id),
      },
    );
    db.assignments.push(a);
    return a;
  };

  const ajouterRepos = (data: Ligne): Ligne | null => {
    if (db.restDays.some((r) => r.deliverer_id === data.deliverer_id && egal(r.date, data.date))) return null;
    const r = lier(
      { id: nouvelId(), source: RestDaySource.AUTO, reason: null, ...data },
      { deliverer: () => db.deliverers.find((d) => d.id === r.deliverer_id) },
    );
    db.restDays.push(r);
    return r;
  };

  const supprimerPlans = (ids: string[]) => {
    const shiftIds = new Set(db.shifts.filter((s) => ids.includes(s.plan_id)).map((s) => s.id));
    db.assignments = db.assignments.filter((a) => !shiftIds.has(a.shift_id));
    db.shifts = db.shifts.filter((s) => !shiftIds.has(s.id));
    db.plans = db.plans.filter((p) => !ids.includes(p.id));
  };

  const lecture = (lignes: () => Ligne[]) => ({
    findMany: jest.fn(async (a: Ligne = {}) =>
      trier(distinctes(lignes().filter((l) => correspond(l, a.where)), a.distinct), a.orderBy)
        .slice(0, a.take ?? Infinity)
        .map((l) => projeter(l, a)),
    ),
    findFirst: jest.fn(async (a: Ligne = {}) => {
      const l = trier(lignes().filter((x) => correspond(x, a.where)), a.orderBy)[0];
      return l ? projeter(l, a) : null;
    }),
    findUnique: jest.fn(async (a: Ligne) => {
      const l = lignes().find((x) => correspond(x, aPlat(a.where)));
      return l ? projeter(l, a) : null;
    }),
  });

  const ecrire = (lignes: () => Ligne[]) => ({
    updateMany: jest.fn(async ({ where, data }: Ligne) => {
      const cibles = lignes().filter((l) => correspond(l, where));
      cibles.forEach((l) => Object.assign(l, data));
      return { count: cibles.length };
    }),
    update: jest.fn(async ({ where, data }: Ligne) => {
      const l = lignes().find((x) => correspond(x, where));
      if (!l) throw new Error('Enregistrement introuvable');
      Object.assign(l, data);
      return projeter(l);
    }),
  });

  const prisma: Ligne = {
    restaurant: { ...lecture(() => db.restaurants) },
    deliverer: { ...lecture(() => db.deliverers) },
    schedulePlan: {
      ...lecture(() => db.plans),
      ...ecrire(() => db.plans),
      findUniqueOrThrow: jest.fn(async (a: Ligne) => {
        const l = db.plans.find((x) => correspond(x, a.where));
        if (!l) throw new Error('Enregistrement introuvable');
        return projeter(l, a);
      }),
      create: jest.fn(async ({ data }: Ligne) => projeter(ajouterPlan(data))),
      deleteMany: jest.fn(async ({ where }: Ligne) => {
        const ids = db.plans.filter((p) => correspond(p, where)).map((p) => p.id);
        supprimerPlans(ids);
        return { count: ids.length };
      }),
      delete: jest.fn(async ({ where }: Ligne) => {
        const p = db.plans.find((x) => correspond(x, where));
        if (!p) throw new Error('Enregistrement introuvable');
        supprimerPlans([p.id]);
        return projeter(p);
      }),
    },
    shift: {
      ...lecture(() => db.shifts),
      createManyAndReturn: jest.fn(async ({ data, select }: Ligne) =>
        (data as Ligne[]).map((d) => projeter(ajouterShift(d), { select })),
      ),
    },
    shiftAssignment: {
      ...lecture(() => db.assignments),
      ...ecrire(() => db.assignments),
      createMany: jest.fn(async ({ data }: Ligne) => ({
        count: (data as Ligne[]).map(ajouterAffectation).filter(Boolean).length,
      })),
      deleteMany: jest.fn(async ({ where }: Ligne) => {
        const avant = db.assignments.length;
        db.assignments = db.assignments.filter((a) => !correspond(a, where));
        return { count: avant - db.assignments.length };
      }),
      groupBy: jest.fn(async ({ by, where }: Ligne) => {
        const groupes = new Map<string, number>();
        for (const a of db.assignments.filter((x) => correspond(x, where))) {
          const cle = a[(by as string[])[0]];
          groupes.set(cle, (groupes.get(cle) ?? 0) + 1);
        }
        return [...groupes].map(([status, n]) => ({ status, _count: { _all: n } }));
      }),
    },
    restDay: {
      ...lecture(() => db.restDays),
      createMany: jest.fn(async ({ data }: Ligne) => ({
        count: (data as Ligne[]).map(ajouterRepos).filter(Boolean).length,
      })),
      deleteMany: jest.fn(async ({ where }: Ligne) => {
        const avant = db.restDays.length;
        db.restDays = db.restDays.filter((r) => !correspond(r, where));
        return { count: avant - db.restDays.length };
      }),
      upsert: jest.fn(async ({ where, update, create }: Ligne) => {
        const l = db.restDays.find((x) => correspond(x, aPlat(where)));
        if (l) return projeter(Object.assign(l, update));
        return projeter(ajouterRepos(create)!);
      }),
    },
  };
  prisma.$transaction = jest.fn(async (arg: unknown) =>
    Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: Ligne) => Promise<unknown>)(prisma),
  );

  const reglages = { load: jest.fn(async () => REGLAGES) };
  const push = { notifyPlanSent: jest.fn(), notifyPlanModifie: jest.fn() };
  const audit = { record: jest.fn() };

  const planning = new SchedulePlanningService(prisma as any, reglages as any, push as any, audit as any);
  const requetes = new ScheduleQueryService(prisma as any, reglages as any);
  const controleur = new ScheduleAdminController(planning, requetes);
  const evenements = { planSent: jest.fn(), presenceCheckRequest: jest.fn() };
  const taches = new ScheduleTask(prisma as any, reglages as any, planning, evenements as any, push as any);

  // ── Données de départ ─────────────────────────────────────────────────
  db.restaurants.push(
    { id: RESTO_A, name: 'Angré', entity_status: EntityStatus.ACTIVE },
    { id: RESTO_B, name: 'Marcory', entity_status: EntityStatus.ACTIVE },
  );
  const livreur = (id: string, first_name: string, last_name: string, restaurant_id: string, surcharge: Ligne = {}) =>
    db.deliverers.push({
      id,
      first_name,
      last_name,
      image: null,
      phone: '+2250700000000',
      type_vehicule: null,
      genre: Genre.HOMME,
      restaurant_id,
      status: DelivererStatus.ACTIVE,
      entity_status: EntityStatus.ACTIVE,
      created_at: new Date(numero++),
      ...surcharge,
    });
  livreur(KOFFI, 'Koffi', 'Yao', RESTO_A);
  livreur(ALI, 'Ali', 'Traoré', RESTO_A);
  livreur(AWA, 'Awa', 'Koné', RESTO_A, { genre: Genre.FEMME });
  livreur(SUSPENDU, 'Moussa', 'Diallo', RESTO_A, { status: DelivererStatus.SUSPENDED });
  livreur(LIVREUR_B, 'Yao', 'Kouassi', RESTO_B);

  /**
   * Planning du 26/10 (lundi) au 08/11 (dimanche), Koffi et Ali sur tous
   * leurs jours de travail, matin et soir. Repos : Koffi les lundis 26/10 et
   * 02/11, Ali les mardis 27/10 et 03/11 (calcul). Koffi a posé lui-même un
   * repos le mercredi 04/11 (pas d'affectation ce jour-là).
   */
  const planningAngre = (statut: SchedulePlanStatus, surcharge: Ligne = {}) => {
    const plan = ajouterPlan({
      restaurant_id: RESTO_A,
      period_start: jour('2026-10-26'),
      period_end: jour('2026-11-08'),
      status: statut,
      sent_at: statut === SchedulePlanStatus.DRAFT ? null : new Date(),
      ...surcharge,
    });
    const repos: Record<string, string[]> = {
      [KOFFI]: ['2026-10-26', '2026-11-02'],
      [ALI]: ['2026-10-27', '2026-11-03'],
    };
    for (let d = new Date(plan.period_start); d <= plan.period_end; d = new Date(d.getTime() + 86_400_000)) {
      for (const type of [ShiftType.MORNING, ShiftType.EVENING]) {
        const s = ajouterShift({
          plan_id: plan.id,
          date: d,
          type,
          start_time: type === ShiftType.MORNING ? '09:00' : '15:00',
          end_time: type === ShiftType.MORNING ? '15:00' : '23:00',
          max_slots: 3,
        });
        const cle = d.toISOString().slice(0, 10);
        for (const id of [KOFFI, ALI]) {
          if (repos[id].includes(cle) || (id === KOFFI && cle === '2026-11-04')) continue;
          ajouterAffectation({ shift_id: s.id, deliverer_id: id });
        }
      }
    }
    for (const [id, jours] of Object.entries(repos)) {
      for (const j of jours) ajouterRepos({ deliverer_id: id, date: jour(j), source: RestDaySource.AUTO });
    }
    ajouterRepos({ deliverer_id: KOFFI, date: jour('2026-11-04'), source: RestDaySource.MANUAL_DELIVERER });
    return plan;
  };

  /** Requête vue par le contrôleur : le compte connecté et la route. */
  const requete = (user: User, method = 'PATCH', path = '/api/v1/schedule/plans') =>
    ({ user, method, originalUrl: path, url: path }) as any;

  return {
    db,
    prisma,
    push,
    audit,
    reglages,
    planning,
    requetes,
    controleur,
    taches,
    planningAngre,
    ajouterPlan,
    ajouterShift,
    ajouterAffectation,
    ajouterRepos,
    requete,
  };
}

export type Base = ReturnType<typeof monterBase>;
