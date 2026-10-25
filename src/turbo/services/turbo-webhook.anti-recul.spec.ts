/**
 * WEBHOOKS TURBO EN RETARD OU REJOUÉS (défaut relevé le 22/10).
 *
 * Règle : les états d'une course, d'une livraison et d'une commande ne
 * reculent jamais sur un webhook. Un webhook en retard ou rejoué est accepté
 * (réponse 200 : Turbo ne le renvoie pas), sans effet, et noté au journal du
 * serveur.
 *
 * Avant : `advanceCourse` (et `syncStatus` pour la commande) lisait l'état, le
 * comparait, puis écrivait SANS condition. Un « livreur trouvé » lu avant la
 * validation du retrait par la caisse et écrit juste après ramenait la course
 * validée à « acceptée » ; un « récupérée » lu avant la validation du code du
 * client ramenait la commande livrée à « en livraison ». Et rien n'était noté.
 *
 * Base simulée (base-dispatch.simulee-spec.ts), aucun appel sortant.
 */
import { Logger } from '@nestjs/common';
import { CourseStatut, DeliveryService, DeliveryStatut, OrderStatus } from '@prisma/client';

import { CourseChannels } from 'src/modules/course/enums/course-channels';
import {
  DonneesDispatch,
  courseAvecCommandes,
  monterBaseDispatch,
} from 'src/modules/course/services/base-dispatch.simulee-spec';
import { OrderChannels } from 'src/modules/order/enums/order-channels';

import { WebhookEvent } from '../enums/webhook-event.enum';
import { TurboWebhookService } from './turbo-webhook.service';

const MAINTENANT = new Date('2026-10-22T14:00:00.000Z');
const avant = (min: number) => new Date(MAINTENANT.getTime() - min * 60_000);

function monter(donnees: DonneesDispatch) {
  const base = monterBaseDispatch(donnees);
  const gateway = { emitToUser: jest.fn(), emitToBackoffice: jest.fn(), emitToRestaurant: jest.fn() };
  const bus = { emit: jest.fn() };
  const service = new TurboWebhookService(
    gateway as never,
    base.prisma,
    bus as never,
    { sendTurboPaymentPendingBell: jest.fn(async () => undefined) } as never,
    { notifier: jest.fn(async () => undefined) } as never,
  );
  const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  return { ...base, gateway, bus, service, warn };
}

/** Course Turbo d'une commande prête, livraison en attente. */
function courseTurbo(surcharge: Record<string, unknown>, statutCommande: OrderStatus = OrderStatus.READY) {
  const donnees = courseAvecCommandes({ turbo_escalated_at: avant(10), ...surcharge }, [statutCommande]);
  Object.assign(donnees.commandes[0], { delivery_service: DeliveryService.TURBO, paied: true, customer_id: 'client-1' });
  return donnees;
}

/** Ce qui est parti sur un canal donné, toutes salles confondues. */
const emis = (t: ReturnType<typeof monter>, canal: string) =>
  [...t.gateway.emitToBackoffice.mock.calls, ...t.gateway.emitToRestaurant.mock.calls, ...t.gateway.emitToUser.mock.calls]
    .filter((appel) => appel.includes(canal)).length;

beforeEach(() => {
  jest.useFakeTimers({ now: MAINTENANT, doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('webhooks Turbo : jamais de recul, un webhook en retard est accepté sans effet et noté', () => {
  it('« livreur trouvé » lu avant la validation du retrait, écrit après : la course reste en livraison', async () => {
    const { course: c, commandes, livraisons } = courseTurbo({ statut: CourseStatut.PENDING_ASSIGNMENT });
    const t = monter({ courses: [c], commandes, livraisons });
    const lire = t.prisma.course.findUnique.getMockImplementation();
    t.prisma.course.findUnique.mockImplementationOnce(async (args: any) => {
      const lue = await lire(args);
      // La caissière valide le retrait juste après la lecture du webhook.
      Object.assign(c, { statut: CourseStatut.IN_DELIVERY, picked_up_at: MAINTENANT });
      return lue;
    });

    const reponse = await t.service.handleCourierAssigned({ numero: commandes[0].reference, courierId: 'T-12' });

    expect(reponse).toEqual({ event: WebhookEvent.DELIVERY_COURIER_ASSIGNED, received: true, process: true });
    expect(c).toMatchObject({ statut: CourseStatut.IN_DELIVERY, assigned_at: null });
    expect(emis(t, CourseChannels.COURSE_STATUT_CHANGED)).toBe(0);
    expect(t.warn).toHaveBeenCalledWith(expect.stringContaining(`course ${c.reference} déjà IN_DELIVERY`));
  });

  it('« récupérée » et « en route » rejoués après « livrée » : rien ne recule, rien n’est émis, c’est noté', async () => {
    const { course: c, commandes, livraisons } = courseTurbo(
      { statut: CourseStatut.COMPLETED, completed_at: avant(1) },
      OrderStatus.COMPLETED,
    );
    Object.assign(livraisons[0], { statut: DeliveryStatut.DELIVERED, delivered_at: avant(1) });
    const t = monter({ courses: [c], commandes, livraisons });

    const reponses = [
      await t.service.handlePickedUp({ numero: commandes[0].reference }),
      await t.service.handleInTransit({ numero: commandes[0].reference }),
      await t.service.handleCourierAssigned({ numero: commandes[0].reference, courierId: 'T-12' }),
      await t.service.handlePickupStarted({ numero: commandes[0].reference }),
    ];

    expect(reponses.every((r) => r.received)).toBe(true);
    expect(c.statut).toBe(CourseStatut.COMPLETED);
    expect(livraisons[0].statut).toBe(DeliveryStatut.DELIVERED);
    expect(commandes[0].status).toBe(OrderStatus.COMPLETED);
    expect(t.gateway.emitToUser).not.toHaveBeenCalled();
    expect(t.gateway.emitToBackoffice).not.toHaveBeenCalled();
    expect(t.bus.emit).not.toHaveBeenCalled();
    const notes = t.warn.mock.calls.map((a) => String(a[0]));
    expect(notes).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`Webhook Turbo picked_up sans effet`),
        expect.stringContaining(`course ${c.reference} déjà COMPLETED`),
        expect.stringContaining(`livraison de ${commandes[0].reference} déjà DELIVERED`),
        expect.stringContaining(`commande ${commandes[0].reference} déjà COMPLETED`),
        expect.stringContaining(`Webhook Turbo courier_assigned sans effet`),
        expect.stringContaining(`Webhook Turbo pickup_started sans effet`),
      ]),
    );
  });

  it('« récupérée » lu avant la validation du code du client, écrit après : la commande reste livrée', async () => {
    const { course: c, commandes, livraisons } = courseTurbo({ statut: CourseStatut.AT_RESTAURANT });
    Object.assign(commandes[0], { paied: false });
    const t = monter({ courses: [c], commandes, livraisons });
    const lire = t.prisma.order.findFirst.getMockImplementation();
    t.prisma.order.findFirst.mockImplementationOnce(async (args: any) => {
      const lue = await lire(args);
      // Le code du client est validé juste après la lecture du webhook.
      Object.assign(commandes[0], { status: OrderStatus.COLLECTED, collected_at: MAINTENANT });
      return lue;
    });

    const reponse = await t.service.handlePickedUp({ numero: commandes[0].reference });

    expect(reponse.received).toBe(true);
    expect(commandes[0]).toMatchObject({ status: OrderStatus.COLLECTED, picked_up_at: null });
    expect(emis(t, OrderChannels.ORDER_STATUS_UPDATED)).toBe(0);
    expect(t.bus.emit).not.toHaveBeenCalled();
    expect(t.warn).toHaveBeenCalledWith(expect.stringContaining(`commande ${commandes[0].reference} déjà COLLECTED`));
  });

  it('webhook d’une ancienne course (relancée depuis) : sans effet sur la nouvelle, noté', async () => {
    const { course: c, commandes, livraisons } = courseTurbo({ statut: CourseStatut.PENDING_ASSIGNMENT });
    const t = monter({ courses: [c], commandes, livraisons });

    const reponse = await t.service.handlePickedUp({ numero: commandes[0].reference, referenceCourse: 'CRS-ANCIENNE' });

    expect(reponse.received).toBe(true);
    expect(c.statut).toBe(CourseStatut.PENDING_ASSIGNMENT);
    expect(livraisons[0].statut).toBe(DeliveryStatut.PENDING);
    expect(commandes[0].status).toBe(OrderStatus.READY);
    expect(t.warn).toHaveBeenCalledWith(expect.stringContaining('CRS-ANCIENNE'));
  });

  it('dans l’ordre : la course avance normalement et le prévient', async () => {
    const { course: c, commandes, livraisons } = courseTurbo({ statut: CourseStatut.ACCEPTED });
    const t = monter({ courses: [c], commandes, livraisons });

    await t.service.handlePickedUp({ numero: commandes[0].reference, referenceCourse: c.reference });

    expect(c).toMatchObject({ statut: CourseStatut.IN_DELIVERY, picked_up_at: MAINTENANT });
    expect(livraisons[0].statut).toBe(DeliveryStatut.IN_ROUTE);
    expect(commandes[0].status).toBe(OrderStatus.PICKED_UP);
    expect(t.gateway.emitToBackoffice).toHaveBeenCalledWith(
      CourseChannels.COURSE_STATUT_CHANGED,
      expect.objectContaining({ course_id: c.id, statut: CourseStatut.IN_DELIVERY }),
    );
    expect(emis(t, OrderChannels.ORDER_STATUS_UPDATED)).toBe(3);
    expect(t.warn).not.toHaveBeenCalled();
  });
});
