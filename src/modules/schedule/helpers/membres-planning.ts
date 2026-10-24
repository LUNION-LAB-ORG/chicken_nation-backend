import { Prisma, RestDaySource } from '@prisma/client';

/**
 * Repos qui tiennent un livreur sur un planning : ceux du calcul (`AUTO`) et
 * ceux posés par le restaurant (`MANUAL_ADMIN`). Un repos que le livreur a
 * posé lui-même ne le fait pas entrer dans un planning.
 */
export const SOURCES_REPOS_DU_PLANNING: RestDaySource[] = [RestDaySource.AUTO, RestDaySource.MANUAL_ADMIN];

type Lecteur = Pick<Prisma.TransactionClient, 'shiftAssignment' | 'restDay'>;

interface PlanningPeriode {
  id: string;
  restaurant_id: string;
  period_start: Date;
  period_end: Date;
}

/**
 * Livreurs d'un planning, sans table de membres (conception du 24/10, 11.6) :
 * un livreur en fait partie s'il a au moins une affectation dans le planning,
 * ou, s'il est rattaché au restaurant du planning, au moins un repos `AUTO` ou
 * `MANUAL_ADMIN` dans sa période.
 *
 * Le second cas garde sur le planning un livreur mis en repos tous les jours,
 * qui n'a plus aucune affectation. Les affectations comptent même si le
 * livreur a changé de restaurant depuis : ses cases restent dans la grille.
 */
export async function lireMembresDuPlanning(prisma: Lecteur, plan: PlanningPeriode): Promise<string[]> {
  const [affectes, enRepos] = await Promise.all([
    prisma.shiftAssignment.findMany({
      where: { shift: { plan_id: plan.id } },
      select: { deliverer_id: true },
      distinct: ['deliverer_id'],
    }),
    prisma.restDay.findMany({
      where: {
        date: { gte: plan.period_start, lte: plan.period_end },
        source: { in: SOURCES_REPOS_DU_PLANNING },
        deliverer: { restaurant_id: plan.restaurant_id },
      },
      select: { deliverer_id: true },
      distinct: ['deliverer_id'],
    }),
  ]);
  return [...new Set([...affectes, ...enRepos].map((l) => l.deliverer_id))];
}
