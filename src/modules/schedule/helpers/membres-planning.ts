import { Prisma, RestDaySource, SchedulePlanStatus } from '@prisma/client';

/**
 * Repos qui tiennent un livreur sur un planning : ceux du calcul (`AUTO`) et
 * ceux posés par le restaurant (`MANUAL_ADMIN`). Un repos que le livreur a
 * posé lui-même ne le fait pas entrer dans un planning.
 */
export const SOURCES_REPOS_DU_PLANNING: RestDaySource[] = [RestDaySource.AUTO, RestDaySource.MANUAL_ADMIN];

type Lecteur = Pick<Prisma.TransactionClient, 'shiftAssignment' | 'restDay' | 'schedulePlan'>;

export interface PlanningPeriode {
  id: string;
  restaurant_id: string;
  status: SchedulePlanStatus;
  period_start: Date;
  period_end: Date;
}

/** Un autre planning qui couvre au moins un jour de celui-ci. */
export type PlanningVoisin = PlanningPeriode;

/**
 * Un repos (`RestDay`) appartient au livreur et à une date, pas à un
 * planning : deux plannings qui couvrent le même jour le montrent tous les
 * deux. Qui le garde, hors du planning sur lequel on agit :
 *
 * - un planning d'un AUTRE restaurant, s'il est celui du restaurant actuel du
 *   livreur ou si le livreur y a des affectations (un livreur passé d'Angré à
 *   Marcory : chaque restaurant garde les siens) ;
 * - un autre planning du MÊME restaurant :
 *   - `'tous'` : n'importe lequel (suppression, changement de dates : l'autre
 *     planning montre encore ce repos) ;
 *   - `'en_cours'` : un planning non archivé, et seulement quand on agit sur
 *     un planning archivé (appartenance, retrait : le planning en cours
 *     l'emporte, et un retrait de lui doit bien retirer le livreur).
 */
export type GardeDesRepos = 'tous' | 'en_cours';

const SELECT_REPOS = {
  id: true,
  deliverer_id: true,
  date: true,
  source: true,
  reason: true,
  deliverer: { select: { restaurant_id: true } },
} satisfies Prisma.RestDaySelect;

export type ReposLu = Prisma.RestDayGetPayload<{ select: typeof SELECT_REPOS }>;

const couvre = (p: Pick<PlanningPeriode, 'period_start' | 'period_end'>, jour: Date) =>
  p.period_start.getTime() <= jour.getTime() && p.period_end.getTime() >= jour.getTime();

/**
 * Repos `AUTO` et `MANUAL_ADMIN` dans la période du planning, partagés entre
 * ceux qu'aucun autre planning ne garde (`libres`) et les autres, avec le
 * planning qui les garde (non archivé d'abord).
 */
export async function lireReposDuPlanning(
  prisma: Lecteur,
  plan: PlanningPeriode,
  livreurs: Prisma.RestDayWhereInput,
  garde: GardeDesRepos,
): Promise<{ libres: ReposLu[]; gardes: { repos: ReposLu; planning: PlanningVoisin }[] }> {
  const repos = await prisma.restDay.findMany({
    where: {
      ...livreurs,
      date: { gte: plan.period_start, lte: plan.period_end },
      source: { in: SOURCES_REPOS_DU_PLANNING },
    },
    select: SELECT_REPOS,
  });
  if (repos.length === 0) return { libres: [], gardes: [] };

  const autres = await prisma.schedulePlan.findMany({
    where: {
      id: { not: plan.id },
      period_start: { lte: plan.period_end },
      period_end: { gte: plan.period_start },
    },
    select: { id: true, restaurant_id: true, status: true, period_start: true, period_end: true },
  });
  if (autres.length === 0) return { libres: repos, gardes: [] };
  // Le planning en cours d'abord : c'est lui que le refus nomme.
  autres.sort(
    (a, b) =>
      Number(a.status === SchedulePlanStatus.ARCHIVED) - Number(b.status === SchedulePlanStatus.ARCHIVED) ||
      a.period_start.getTime() - b.period_start.getTime(),
  );

  // Affectations de ces livreurs dans les plannings des autres restaurants.
  const ailleurs = autres.filter((a) => a.restaurant_id !== plan.restaurant_id).map((a) => a.id);
  const affectes = new Set<string>();
  if (ailleurs.length > 0) {
    const lignes = await prisma.shiftAssignment.findMany({
      where: {
        deliverer_id: { in: [...new Set(repos.map((r) => r.deliverer_id))] },
        shift: { plan_id: { in: ailleurs } },
      },
      select: { deliverer_id: true, shift: { select: { plan_id: true } } },
    });
    for (const l of lignes) affectes.add(`${l.deliverer_id}|${l.shift.plan_id}`);
  }

  const gardePar = (r: ReposLu, autre: PlanningVoisin): boolean => {
    if (autre.restaurant_id !== plan.restaurant_id) {
      return autre.restaurant_id === r.deliverer.restaurant_id || affectes.has(`${r.deliverer_id}|${autre.id}`);
    }
    if (garde === 'tous') return true;
    return plan.status === SchedulePlanStatus.ARCHIVED && autre.status !== SchedulePlanStatus.ARCHIVED;
  };

  const libres: ReposLu[] = [];
  const gardes: { repos: ReposLu; planning: PlanningVoisin }[] = [];
  for (const r of repos) {
    const planning = autres.find((a) => couvre(a, r.date) && gardePar(r, a));
    if (planning) gardes.push({ repos: r, planning });
    else libres.push(r);
  }
  return { libres, gardes };
}

/**
 * Livreurs d'un planning, sans table de membres (conception du 24/10, 11.6) :
 * un livreur en fait partie s'il a au moins une affectation dans le planning,
 * ou, s'il est rattaché au restaurant du planning, au moins un repos `AUTO` ou
 * `MANUAL_ADMIN` dans sa période qu'aucun autre planning ne garde (voir
 * `GardeDesRepos`, cas `'en_cours'`).
 *
 * Le second cas garde sur le planning un livreur mis en repos tous les jours,
 * qui n'a plus aucune affectation. Les affectations comptent même si le
 * livreur a changé de restaurant depuis : ses cases restent dans la grille.
 * Les repos de son ancien restaurant, eux, ne le mettent pas sur le planning
 * du nouveau.
 */
export async function lireMembresDuPlanning(prisma: Lecteur, plan: PlanningPeriode): Promise<string[]> {
  const [affectes, enRepos] = await Promise.all([
    prisma.shiftAssignment.findMany({
      where: { shift: { plan_id: plan.id } },
      select: { deliverer_id: true },
      distinct: ['deliverer_id'],
    }),
    lireReposDuPlanning(prisma, plan, { deliverer: { restaurant_id: plan.restaurant_id } }, 'en_cours'),
  ]);
  return [...new Set([...affectes, ...enRepos.libres].map((l) => l.deliverer_id))];
}

/**
 * Plannings non archivés du restaurant qui couvrent au moins un jour de ce
 * planning archivé. Un geste sur l'archivé ne touche pas aux repos de leurs
 * jours : le planning en cours l'emporte. Rien pour un planning non archivé.
 */
export async function plansEnCoursQuiChevauchent(
  prisma: Pick<Prisma.TransactionClient, 'schedulePlan'>,
  plan: PlanningPeriode,
): Promise<PlanningVoisin[]> {
  if (plan.status !== SchedulePlanStatus.ARCHIVED) return [];
  return prisma.schedulePlan.findMany({
    where: {
      id: { not: plan.id },
      restaurant_id: plan.restaurant_id,
      status: { not: SchedulePlanStatus.ARCHIVED },
      period_start: { lte: plan.period_end },
      period_end: { gte: plan.period_start },
    },
    select: { id: true, restaurant_id: true, status: true, period_start: true, period_end: true },
    orderBy: { period_start: 'asc' },
  });
}

/** Le planning de la liste qui couvre ce jour, s'il y en a un. */
export function planningQuiCouvre(plannings: PlanningVoisin[], jour: Date): PlanningVoisin | null {
  return plannings.find((p) => couvre(p, jour)) ?? null;
}
