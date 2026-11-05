/**
 * COMMANDE CONFIÉE À TURBO, FINIE AU COMPTOIR (relevé du 05/11).
 *
 * La caisse suit l'ancien fonctionnement et Turbo n'envoie presque jamais ses
 * étapes : 793 courses sur 798 restaient ouvertes, relues par le planificateur
 * à chaque passage. La commande finie ferme maintenant sa livraison et sa course.
 *
 * Base simulée (base-dispatch.simulee-spec.ts), aucun appel sortant.
 */
import { Logger } from '@nestjs/common';
import { CourseStatut, DeliveryStatut, OrderStatus, OrderType } from '@prisma/client';

import { CourseChannels } from 'src/modules/course/enums/course-channels';
import {
  DonneesDispatch,
  courseAvecCommandes,
  monterBaseDispatch,
} from 'src/modules/course/services/base-dispatch.simulee-spec';

import { CommandeFinieListener } from '../listeners/commande-finie.listener';
import { TurboWebhookService } from './turbo-webhook.service';

const MAINTENANT = new Date('2026-11-05T14:00:00.000Z');
const avant = (min: number) => new Date(MAINTENANT.getTime() - min * 60_000);

function monter(donnees: DonneesDispatch) {
  const base = monterBaseDispatch(donnees);
  const gateway = { emitToUser: jest.fn(), emitToBackoffice: jest.fn(), emitToRestaurant: jest.fn() };
  const service = new TurboWebhookService(
    gateway as never,
    base.prisma,
    { emit: jest.fn() } as never,
    { sendTurboPaymentPendingBell: jest.fn(async () => undefined) } as never,
    { notifier: jest.fn(async () => undefined) } as never,
  );
  const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  return { ...base, gateway, service, warn, error, listener: new CommandeFinieListener(service) };
}

const courseTurbo = (statuts: OrderStatus[], surcharge: Record<string, unknown> = {}) =>
  courseAvecCommandes({ statut: CourseStatut.PENDING_ASSIGNMENT, turbo_escalated_at: avant(30), ...surcharge }, statuts);

const signal = (t: ReturnType<typeof monter>, commande: Record<string, any>, type: OrderType = OrderType.DELIVERY) =>
  t.listener.onStatutCommande({ order: { ...commande, type } } as never);

beforeEach(() => {
  jest.useFakeTimers({ now: MAINTENANT, doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('commande confiée à Turbo, finie au comptoir : la livraison et la course se ferment', () => {
  it.each([OrderStatus.COMPLETED, OrderStatus.COLLECTED])('commande %s : course terminée, sans heure de livraison', async (statut) => {
    const { course: c, commandes, livraisons } = courseTurbo([statut]);
    const t = monter({ courses: [c], commandes, livraisons });

    await signal(t, commandes[0]);

    expect(livraisons[0].statut).toBe(DeliveryStatut.DELIVERED);
    expect(livraisons[0].delivered_at ?? null).toBeNull();
    expect(c).toMatchObject({ statut: CourseStatut.COMPLETED, completed_at: MAINTENANT });
    expect(t.gateway.emitToBackoffice).toHaveBeenCalledWith(
      CourseChannels.COURSE_STATUT_CHANGED,
      expect.objectContaining({ course_id: c.id, statut: CourseStatut.COMPLETED }),
    );
    expect(t.warn).not.toHaveBeenCalled();
  });

  it('course de deux commandes : elle reste ouverte tant que la seconde n’est pas finie', async () => {
    const { course: c, commandes, livraisons } = courseTurbo([OrderStatus.COMPLETED, OrderStatus.PICKED_UP]);
    const t = monter({ courses: [c], commandes, livraisons });

    await signal(t, commandes[0]);
    expect(livraisons[0].statut).toBe(DeliveryStatut.DELIVERED);
    expect(livraisons[1].statut).toBe(DeliveryStatut.PENDING);
    expect(c.statut).toBe(CourseStatut.PENDING_ASSIGNMENT);

    commandes[1].status = OrderStatus.COMPLETED;
    await signal(t, commandes[1]);
    expect(c.statut).toBe(CourseStatut.COMPLETED);
  });

  it('course en livraison (partie sur un webhook) : elle se termine aussi', async () => {
    const { course: c, commandes, livraisons } = courseTurbo([OrderStatus.COMPLETED], { statut: CourseStatut.IN_DELIVERY });
    livraisons[0].statut = DeliveryStatut.IN_ROUTE;
    const t = monter({ courses: [c], commandes, livraisons });

    await signal(t, commandes[0]);

    expect(livraisons[0].statut).toBe(DeliveryStatut.DELIVERED);
    expect(c.statut).toBe(CourseStatut.COMPLETED);
  });

  it('seule commande annulée : livraison et course annulées, par le système', async () => {
    const { course: c, commandes, livraisons } = courseTurbo([OrderStatus.CANCELLED]);
    const t = monter({ courses: [c], commandes, livraisons });

    await signal(t, commandes[0]);

    expect(livraisons[0].statut).toBe(DeliveryStatut.CANCELLED);
    expect(c).toMatchObject({ statut: CourseStatut.CANCELLED, cancelled_by: 'system', cancelled_at: MAINTENANT });
  });

  it('une commande livrée puis la dernière annulée : la course est terminée, pas annulée', async () => {
    const { course: c, commandes, livraisons } = courseTurbo([OrderStatus.COMPLETED, OrderStatus.CANCELLED]);
    const t = monter({ courses: [c], commandes, livraisons });

    await signal(t, commandes[0]);
    await signal(t, commandes[1]);

    expect(livraisons.map((l) => l.statut)).toEqual([DeliveryStatut.DELIVERED, DeliveryStatut.CANCELLED]);
    expect(c.statut).toBe(CourseStatut.COMPLETED);
  });

  it('déjà fermée par le webhook de Turbo : l’heure de livraison reste, rien n’est émis ni noté', async () => {
    const { course: c, commandes, livraisons } = courseTurbo([OrderStatus.COMPLETED], {
      statut: CourseStatut.COMPLETED,
      completed_at: avant(5),
    });
    Object.assign(livraisons[0], { statut: DeliveryStatut.DELIVERED, delivered_at: avant(5) });
    const t = monter({ courses: [c], commandes, livraisons });

    await signal(t, commandes[0]);

    expect(livraisons[0].delivered_at).toEqual(avant(5));
    expect(c.completed_at).toEqual(avant(5));
    expect(t.gateway.emitToBackoffice).not.toHaveBeenCalled();
    expect(t.warn).not.toHaveBeenCalled();
  });

  it('course d’un livreur Chicken Nation : rien ne change', async () => {
    const { course: c, commandes, livraisons } = courseAvecCommandes(
      { statut: CourseStatut.ACCEPTED, deliverer_id: 'livreur-1' },
      [OrderStatus.COMPLETED],
    );
    const t = monter({ courses: [c], commandes, livraisons });

    await signal(t, commandes[0]);

    expect(livraisons[0].statut).toBe(DeliveryStatut.PENDING);
    expect(c.statut).toBe(CourseStatut.ACCEPTED);
  });

  it.each([OrderStatus.READY, OrderStatus.PICKED_UP])('commande %s : encore en cours, rien ne se ferme', async (statut) => {
    const { course: c, commandes, livraisons } = courseTurbo([statut]);
    const t = monter({ courses: [c], commandes, livraisons });

    await signal(t, commandes[0]);

    expect(livraisons[0].statut).toBe(DeliveryStatut.PENDING);
    expect(c.statut).toBe(CourseStatut.PENDING_ASSIGNMENT);
  });

  it('commande à emporter : ignorée sans lecture de la base', async () => {
    const { course: c, commandes, livraisons } = courseTurbo([OrderStatus.COMPLETED]);
    const t = monter({ courses: [c], commandes, livraisons });

    await signal(t, commandes[0], OrderType.PICKUP);

    expect(t.prisma.delivery.findFirst).not.toHaveBeenCalled();
    expect(c.statut).toBe(CourseStatut.PENDING_ASSIGNMENT);
  });

  it('échec en base : noté, jamais remonté à la mise à jour de la commande', async () => {
    const { course: c, commandes, livraisons } = courseTurbo([OrderStatus.COMPLETED]);
    const t = monter({ courses: [c], commandes, livraisons });
    t.prisma.delivery.findFirst.mockRejectedValueOnce(new Error('coupure'));

    await expect(signal(t, commandes[0])).resolves.toBeUndefined();

    expect(t.error).toHaveBeenCalledWith(expect.stringContaining('coupure'));
  });

  it('une position Turbo reçue après la fermeture est toujours enregistrée', async () => {
    const { course: c, commandes, livraisons } = courseTurbo([OrderStatus.COMPLETED]);
    const t = monter({ courses: [c], commandes, livraisons });
    await signal(t, commandes[0]);

    const reponse = await t.service.handleLocationUpdated({ numero: commandes[0].reference, latitude: 5.3, longitude: -4 });

    expect(reponse.process).toBe(true);
    expect(livraisons[0]).toMatchObject({ turbo_courier_lat: 5.3, turbo_courier_lng: -4 });
  });
});
