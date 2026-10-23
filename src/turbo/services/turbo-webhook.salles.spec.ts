/**
 * Webhooks Turbo : la course qui avance (acceptée, au restaurant, en
 * livraison, terminée) ou qu'annule Turbo part aussi à la salle du restaurant
 * (caisse et écran Opérations d'un compte restaurant), plus seulement au
 * siège (relecture du 23/10). Aucun appel sortant.
 */
import { CourseStatut } from '@prisma/client';

import { CourseChannels } from 'src/modules/course/enums/course-channels';

import { TurboWebhookService } from './turbo-webhook.service';

function monter(course: { id: string; statut: CourseStatut; restaurant_id: string }) {
  const sorties: { salle: string; canal: string; charge: any }[] = [];
  const gateway = {
    emitToBackoffice: jest.fn((canal: string, charge: unknown) => sorties.push({ salle: 'siege', canal, charge })),
    emitToRestaurant: jest.fn((id: string, canal: string, charge: unknown) => sorties.push({ salle: `restaurant:${id}`, canal, charge })),
  };
  const prisma = {
    course: {
      findUnique: jest.fn(async ({ select }: { select: Record<string, boolean> }) =>
        Object.fromEntries(Object.keys(select).map((k) => [k, (course as Record<string, unknown>)[k]])),
      ),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => Object.assign(course, data)),
      updateMany: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(course, data);
        return { count: 1 };
      }),
    },
    delivery: { count: jest.fn(async () => 0) },
  };
  const service = new TurboWebhookService(gateway as never, prisma as never, { emit: jest.fn() } as never, {} as never, {} as never);
  return { service: service as unknown as Record<string, (...args: unknown[]) => Promise<void>>, sorties };
}

describe('webhooks Turbo : salle du restaurant prévenue', () => {
  it('course acceptée par un livreur Turbo : siège ET restaurant', async () => {
    const { service, sorties } = monter({ id: 'k1', statut: CourseStatut.PENDING_ASSIGNMENT, restaurant_id: 'r1' });
    await service.advanceCourse('k1', CourseStatut.ACCEPTED);
    expect(sorties.map((s) => s.salle)).toEqual(['siege', 'restaurant:r1']);
    for (const s of sorties) {
      expect(s).toMatchObject({ canal: CourseChannels.COURSE_STATUT_CHANGED, charge: { course_id: 'k1', statut: CourseStatut.ACCEPTED, source: 'turbo' } });
    }
  });

  it('course annulée par Turbo, plus aucune livraison active : siège ET restaurant', async () => {
    const { service, sorties } = monter({ id: 'k1', statut: CourseStatut.ACCEPTED, restaurant_id: 'r1' });
    await service.cancelCourseIfNoDeliveryLeft('k1', 'Annulée par Turbo');
    expect(sorties.map((s) => s.salle)).toEqual(['siege', 'restaurant:r1']);
    expect(sorties[1].charge).toMatchObject({ statut: CourseStatut.CANCELLED, raison: 'Annulée par Turbo' });
  });

  it('webhook rejoué (la course ne recule pas) : rien n’est émis', async () => {
    const { service, sorties } = monter({ id: 'k1', statut: CourseStatut.IN_DELIVERY, restaurant_id: 'r1' });
    await service.advanceCourse('k1', CourseStatut.ACCEPTED);
    expect(sorties).toEqual([]);
  });
});
