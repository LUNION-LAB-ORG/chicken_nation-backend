/**
 * FIN D'UNE LIVRAISON PAR LE LIVREUR (relecture du 25/10) : « Problème »
 * (PATCH /courses/deliverer/deliveries/:id/fail) et code du client
 * (PATCH .../confirm).
 *
 *  - seule une livraison en cours d'une course partie peut échouer : jamais
 *    une livraison déjà confirmée (commande payée et terminée, points et
 *    coupon rendus à tort), ni une course pas encore récupérée ou annulée ;
 *  - un rejeu (réponse perdue, double toucher) rend la livraison telle
 *    quelle, sans second événement ;
 *  - la course ne passe terminée qu'une fois.
 *
 * Les VRAIS services sur la base simulée (banc-planificateur.simulee-spec.ts).
 */
import { BadRequestException } from '@nestjs/common';
import { CourseStatut, DeliveryFailureReason, DeliveryStatut, OrderStatus } from '@prisma/client';

import { CourseChannels } from '../enums/course-channels';
import { course, livraison, livreur } from './base-dispatch.simulee-spec';
import { AU_COMPTOIR, avant, B, MAINTENANT, monter, prete } from './banc-planificateur.simulee-spec';

beforeEach(() => {
  jest.useFakeTimers({ now: MAINTENANT, doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const CLIENT_ABSENT = { reason: DeliveryFailureReason.CLIENT_ABSENT, note: 'Client absent' };

/** Course partie de deux arrêts : A arrivé (payée), B en attente. */
function enLivraison(surcharge: { statutCourse?: CourseStatut } = {}) {
  const d1 = livreur({ ...AU_COMPTOIR, last_available_at: null, protocole_appli: 4 });
  const a = prete({ status: OrderStatus.PICKED_UP, picked_up_at: avant(600), paied: true });
  const b = prete({ address: B, status: OrderStatus.PICKED_UP, picked_up_at: avant(600), paied: true });
  const k = course({
    statut: surcharge.statutCourse ?? CourseStatut.IN_DELIVERY,
    deliverer_id: d1.id,
    assigned_at: avant(1200),
    picked_up_at: avant(600),
    parti_at: avant(590),
  });
  const la = livraison({
    course_id: k.id,
    order_id: a.id,
    sequence_order: 1,
    statut: DeliveryStatut.ARRIVED,
    in_route_at: avant(590),
    arrived_at: avant(30),
    delivery_pin: '4821',
  });
  const lb = livraison({ course_id: k.id, order_id: b.id, sequence_order: 2 });
  const t = monter({ commandes: [a, b], courses: [k], livraisons: [la, lb], livreurs: [d1] });
  return { d1, a, b, k, la, lb, t };
}

async function refus(promesse: Promise<unknown>) {
  try {
    await promesse;
  } catch (e) {
    return e as Error;
  }
  throw new Error('La promesse devait être rejetée');
}

describe('« Problème » sur une livraison (failDelivery)', () => {
  it('livraison arrivée : échec écrit, commande annulée par le livreur, un événement', async () => {
    const { d1, a, la, t } = enLivraison();

    const reponse = await t.actionsLivraison.failDelivery(la.id, d1.id, CLIENT_ABSENT);

    expect(reponse).toMatchObject({ id: la.id, statut: DeliveryStatut.FAILED, failure_reason: DeliveryFailureReason.CLIENT_ABSENT });
    expect(a).toMatchObject({ status: OrderStatus.CANCELLED, cancelled_by: 'deliverer', cancelled_reason: 'Client absent' });
    expect(t.emisSur(CourseChannels.DELIVERY_STATUT_CHANGED)).toEqual([
      expect.objectContaining({ previous_statut: DeliveryStatut.ARRIVED, new_statut: DeliveryStatut.FAILED }),
    ]);
  });

  it('livraison déjà confirmée avec le code (réponse perdue, puis « Client absent ») : 400, la commande payée reste terminée', async () => {
    const { d1, a, k, la, t } = enLivraison();
    await t.actionsLivraison.confirmDelivery(la.id, d1.id, { pin: '4821' } as never);
    expect(a.status).toBe(OrderStatus.COMPLETED);
    const evenements = t.emisSur(CourseChannels.DELIVERY_STATUT_CHANGED).length;

    expect(await refus(t.actionsLivraison.failDelivery(la.id, d1.id, CLIENT_ABSENT))).toBeInstanceOf(BadRequestException);

    expect(la.statut).toBe(DeliveryStatut.DELIVERED);
    expect(a).toMatchObject({ status: OrderStatus.COMPLETED, cancelled_at: null });
    expect(a.cancelled_by).toBeUndefined();
    expect(t.emisSur(CourseChannels.DELIVERY_STATUT_CHANGED)).toHaveLength(evenements);
    expect(k.statut).toBe(CourseStatut.IN_DELIVERY);
  });

  it('course pas encore récupérée (acceptée, au restaurant) ou annulée : 400, rien n’est annulé', async () => {
    for (const statutCourse of [CourseStatut.ACCEPTED, CourseStatut.AT_RESTAURANT, CourseStatut.CANCELLED]) {
      const { d1, a, b, lb, t } = enLivraison({ statutCourse });
      expect(await refus(t.actionsLivraison.failDelivery(lb.id, d1.id, CLIENT_ABSENT))).toBeInstanceOf(BadRequestException);
      expect(lb.statut).toBe(DeliveryStatut.PENDING);
      expect(a.status).toBe(OrderStatus.PICKED_UP);
      expect(b.status).toBe(OrderStatus.PICKED_UP);
      expect(t.emisSur(CourseChannels.DELIVERY_STATUT_CHANGED)).toHaveLength(0);
    }
  });

  it('rejeu de « Problème » (réponse perdue, double toucher) : la livraison est rendue, sans second événement', async () => {
    const { d1, la, t } = enLivraison();
    await t.actionsLivraison.failDelivery(la.id, d1.id, CLIENT_ABSENT);

    const rejeu = await t.actionsLivraison.failDelivery(la.id, d1.id, CLIENT_ABSENT);

    expect(rejeu).toMatchObject({ id: la.id, statut: DeliveryStatut.FAILED });
    expect(t.emisSur(CourseChannels.DELIVERY_STATUT_CHANGED)).toHaveLength(1);
  });

  it('livraison confirmée entre la lecture et l’écriture : rien n’est écrit, 400', async () => {
    const { d1, a, la, t } = enLivraison();
    const lire = t.base.prisma.delivery.findUnique.getMockImplementation()!;
    let appels = 0;
    t.base.prisma.delivery.findUnique.mockImplementation(async (...args: Parameters<typeof lire>) => {
      const lue = await lire(...args);
      // Lecture de contrôle faite : le code du client est validé au même instant.
      if (++appels === 2) {
        la.statut = DeliveryStatut.DELIVERED;
        a.status = OrderStatus.COMPLETED;
      }
      return lue;
    });

    expect(await refus(t.actionsLivraison.failDelivery(la.id, d1.id, CLIENT_ABSENT))).toBeInstanceOf(BadRequestException);
    expect(la.statut).toBe(DeliveryStatut.DELIVERED);
    expect(a.status).toBe(OrderStatus.COMPLETED);
    expect(t.emisSur(CourseChannels.DELIVERY_STATUT_CHANGED)).toHaveLength(0);
  });

  it('livraison d’un autre livreur : 403', async () => {
    const { la, t } = enLivraison();
    expect((await refus(t.actionsLivraison.failDelivery(la.id, 'un-autre', CLIENT_ABSENT))).message).toBe(
      'Cette livraison ne vous est pas affectée',
    );
  });

  it('dernier arrêt en échec : course terminée une seule fois, même si deux fins arrivent ensemble', async () => {
    const { d1, k, la, lb, t } = enLivraison();
    lb.statut = DeliveryStatut.IN_ROUTE;

    await Promise.all([
      t.actionsLivraison.confirmDelivery(la.id, d1.id, { pin: '4821' } as never),
      t.actionsLivraison.failDelivery(lb.id, d1.id, CLIENT_ABSENT),
    ]);

    expect(k.statut).toBe(CourseStatut.COMPLETED);
    expect(t.emisSur(CourseChannels.COURSE_COMPLETED)).toHaveLength(1);
  });
});

describe('code du client (confirmDelivery)', () => {
  it('rejeu de la confirmation (réponse perdue) avec le bon code : la livraison est rendue, sans second événement', async () => {
    const { d1, a, la, t } = enLivraison();
    await t.actionsLivraison.confirmDelivery(la.id, d1.id, { pin: '4821' } as never);

    const rejeu = await t.actionsLivraison.confirmDelivery(la.id, d1.id, { pin: '4821' } as never);

    expect(rejeu).toMatchObject({ id: la.id, statut: DeliveryStatut.DELIVERED });
    expect(a.status).toBe(OrderStatus.COMPLETED);
    expect(t.emisSur(CourseChannels.DELIVERY_STATUT_CHANGED)).toHaveLength(1);
  });

  it('rejeu avec un autre code : 400 comme avant', async () => {
    const { d1, la, t } = enLivraison();
    await t.actionsLivraison.confirmDelivery(la.id, d1.id, { pin: '4821' } as never);
    expect(await refus(t.actionsLivraison.confirmDelivery(la.id, d1.id, { pin: '0000' } as never))).toBeInstanceOf(
      BadRequestException,
    );
  });

  it('« Problème » validé entre la lecture et l’écriture : la confirmation n’efface pas l’échec, 400', async () => {
    const { d1, a, la, t } = enLivraison();
    const lire = t.base.prisma.delivery.findUnique.getMockImplementation()!;
    let appels = 0;
    t.base.prisma.delivery.findUnique.mockImplementation(async (...args: Parameters<typeof lire>) => {
      const lue = await lire(...args);
      if (++appels === 2) {
        la.statut = DeliveryStatut.FAILED;
        a.status = OrderStatus.CANCELLED;
      }
      return lue;
    });

    expect(await refus(t.actionsLivraison.confirmDelivery(la.id, d1.id, { pin: '4821' } as never))).toBeInstanceOf(
      BadRequestException,
    );
    expect(la.statut).toBe(DeliveryStatut.FAILED);
    expect(a.status).toBe(OrderStatus.CANCELLED);
  });
});
