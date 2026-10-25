/**
 * Alerte « Course en retard » du cron (`detecterRetards`) : la retenue au
 * comptoir après la remise ne compte pas comme tournée (relecture du 25/10).
 * La caisse remet A dès le code à 15 h 28 min 30 s, la course attend B
 * jusqu'à 15 h 40, le livreur part à 15 h 41 ; tournée estimée à 26 min,
 * facteur 1,5 : alerte 39 min après 15 h 40, jamais 39 min après la remise.
 */
import { CourseStatut } from '@prisma/client';

import { CourseTask } from './course.task';

const COURSE: Record<string, unknown> = {
  id: 'k',
  reference: 'CRS-K',
  restaurant_id: 'r',
  statut: CourseStatut.IN_DELIVERY,
  picked_up_at: new Date('2026-10-25T15:28:30.000Z'),
  retenue_jusqua: new Date('2026-10-25T15:40:00.000Z'),
  parti_at: new Date('2026-10-25T15:41:00.000Z'),
  motif_depart: 'POSITION',
  estimated_duration_min: 26,
  delay_alerted_at: null,
};

function monter() {
  const prisma = {
    course: {
      // Seules les colonnes demandées reviennent, comme Prisma.
      findMany: jest.fn(async ({ select }: { select: Record<string, boolean> }) => [
        Object.fromEntries(Object.keys(select).map((c) => [c, COURSE[c]])),
      ]),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
  };
  const settings = { load: jest.fn(async () => ({ delayAlertFactor: 1.5 })) };
  const cloche = { sendCourseDelayBell: jest.fn(async () => undefined) };
  const task = new CourseTask(prisma as never, {} as never, {} as never, settings as never, cloche as never);
  return { prisma, cloche, task };
}

afterEach(() => jest.useRealTimers());

describe('detecterRetards : retenue au comptoir après la remise', () => {
  it('16 h 08 min 30 s (40 min après la remise, 1 min après la fin prévue) : pas d’alerte', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-25T16:08:30.000Z') });
    const t = monter();
    await t.task.detecterRetards();
    expect(t.cloche.sendCourseDelayBell).not.toHaveBeenCalled();
    expect(t.prisma.course.updateMany).not.toHaveBeenCalled();
  });

  it('16 h 19 min 30 s (39 min 30 s après la fin de la retenue) : alerte, minutes comptées de là', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-25T16:19:30.000Z') });
    const t = monter();
    await t.task.detecterRetards();
    expect(t.cloche.sendCourseDelayBell).toHaveBeenCalledWith({ reference: 'CRS-K', restaurantId: 'r', estimeMin: 26, ecouleMin: 40 });
  });
});
