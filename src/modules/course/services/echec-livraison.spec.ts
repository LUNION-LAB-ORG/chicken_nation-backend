/**
 * Fin d'une livraison par le livreur (relecture et correction du 25/10) :
 * « Problème » (PATCH /courses/deliverer/deliveries/:deliveryId/fail) et code
 * du client (PATCH .../confirm).
 *
 * Avant le 25/10, « Problème » ne vérifiait que le livreur de la course, par
 * une lecture à part, et ni l'état de la livraison ni celui de la course : le
 * livreur passait en échec une livraison déjà remise (la commande payée et
 * terminée du client devenait annulée, points et coupon rendus), une
 * livraison de sa course pas encore récupérée ou annulée, ou une livraison que
 * le regroupement venait de confier à un autre livreur (la commande de
 * l'autre était annulée).
 *
 * Règle : comme démarrer, arrivé et confirmer, seulement SA livraison encore à
 * faire (en attente, en route, arrivé) dans sa course en livraison ; écriture
 * conditionnée, d'un seul tenant avec la commande. Un rejeu (réponse perdue,
 * double toucher) rend la livraison telle quelle, sans second événement ; la
 * course ne passe terminée qu'une fois.
 *
 * Deux bancs : la route du livreur sur la base simulée du dispatch, puis les
 * VRAIS services sur la base simulée du planificateur
 * (banc-planificateur.simulee-spec.ts).
 */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { CourseStatut, DeliveryFailureReason, DeliveryStatut, OrderStatus } from '@prisma/client';

import { CourseDelivererController } from '../controllers/course-deliverer.controller';
import { CourseChannels } from '../enums/course-channels';
import { DonneesDispatch, commande, course, courseAvecCommandes, livraison, livreur, monterBaseDispatch } from './base-dispatch.simulee-spec';
import { AU_COMPTOIR, avant, B, MAINTENANT, monter as monterBanc, prete } from './banc-planificateur.simulee-spec';
import { DeliveryActionService } from './delivery-action.service';

function monter(donnees: DonneesDispatch) {
  const base = monterBaseDispatch(donnees);
  const courseEvent = {
    deliveryStatutChanged: jest.fn(async () => undefined),
    courseCompleted: jest.fn(async () => undefined),
  };
  const file = { onComplete: jest.fn(async () => undefined) };
  const push = { notifyCourseCompleted: jest.fn() };
  const livraisons = new DeliveryActionService(base.prisma, courseEvent as never, file as never, push as never, {} as never);
  const controleur = new CourseDelivererController({} as never, livraisons, {} as never, {} as never, {} as never);
  /** Ce que fait la route : livreur lu du jeton, identifiant de l'URL, corps tel quel. */
  const echouer = (livreurConnecte: Record<string, any>, deliveryId: string, corps: Record<string, unknown>) =>
    controleur.failDelivery(livreurConnecte as never, deliveryId, corps as never);
  /**
   * Un changement fait par quelqu'un d'autre juste APRÈS la lecture de contrôle
   * de la route (livreur, course et état de la livraison), avant l'écriture.
   * La lecture du rejeu, plus tôt, ne compte pas.
   */
  const apresLaLecture = (changer: () => void) => {
    const lire = base.prisma.delivery.findUnique.getMockImplementation();
    let fait = false;
    base.prisma.delivery.findUnique.mockImplementation(async (args: any) => {
      const lue = await lire(args);
      if (!fait && args?.include?.course) {
        fait = true;
        changer();
      }
      return lue;
    });
  };
  return { ...base, courseEvent, file, push, echouer, apresLaLecture };
}

const CLIENT_ABSENT = { reason: DeliveryFailureReason.CLIENT_ABSENT };

describe('échec d’une livraison par le livreur (route)', () => {
  it.each([DeliveryStatut.PENDING, DeliveryStatut.IN_ROUTE, DeliveryStatut.ARRIVED])(
    'A passe en échec SA livraison (%s) : échec, commande annulée avec le motif, course terminée, comme avant',
    async (statut) => {
      const a = livreur();
      const { course: c, commandes, livraisons } = courseAvecCommandes(
        { statut: CourseStatut.IN_DELIVERY, deliverer_id: a.id },
        [OrderStatus.PICKED_UP],
      );
      livraisons[0].statut = statut;
      const t = monter({ livreurs: [a], courses: [c], commandes, livraisons });

      const rendue = await t.echouer(a, livraisons[0].id, CLIENT_ABSENT);

      expect(rendue).toMatchObject({ id: livraisons[0].id, statut: DeliveryStatut.FAILED });
      expect(livraisons[0]).toMatchObject({ statut: DeliveryStatut.FAILED, failure_reason: DeliveryFailureReason.CLIENT_ABSENT });
      expect(commandes[0]).toMatchObject({
        status: OrderStatus.CANCELLED,
        cancelled_by: 'deliverer',
        cancelled_reason: 'Livraison échouée : CLIENT_ABSENT',
      });
      expect(t.courseEvent.deliveryStatutChanged).toHaveBeenCalledWith(
        expect.objectContaining({ previous_statut: statut, new_statut: DeliveryStatut.FAILED }),
      );
      expect(c.statut).toBe(CourseStatut.COMPLETED);
      expect(t.file.onComplete).toHaveBeenCalledWith(a.id);
    },
  );

  it('livraison déjà remise (commande terminée) : 400, la commande du client reste terminée', async () => {
    const a = livreur();
    const { course: c, commandes, livraisons } = courseAvecCommandes(
      { statut: CourseStatut.IN_DELIVERY, deliverer_id: a.id },
      [OrderStatus.COMPLETED, OrderStatus.PICKED_UP],
    );
    livraisons[0].statut = DeliveryStatut.DELIVERED;
    livraisons[1].statut = DeliveryStatut.IN_ROUTE;
    const t = monter({ livreurs: [a], courses: [c], commandes, livraisons });

    const refus = t.echouer(a, livraisons[0].id, CLIENT_ABSENT);
    await expect(refus).rejects.toBeInstanceOf(BadRequestException);
    await expect(refus).rejects.toThrow('Statut delivery attendu PENDING ou IN_ROUTE ou ARRIVED, actuel DELIVERED');

    expect(livraisons[0].statut).toBe(DeliveryStatut.DELIVERED);
    expect(commandes[0].status).toBe(OrderStatus.COMPLETED);
    expect(c.statut).toBe(CourseStatut.IN_DELIVERY);
    expect(t.courseEvent.deliveryStatutChanged).not.toHaveBeenCalled();
  });

  it.each([CourseStatut.ACCEPTED, CourseStatut.AT_RESTAURANT, CourseStatut.COMPLETED, CourseStatut.CANCELLED])(
    'course pas en livraison (%s) : 400 « La course doit être en phase IN_DELIVERY », rien n’est écrit',
    async (statut) => {
      const a = livreur();
      const { course: c, commandes, livraisons } = courseAvecCommandes({ statut, deliverer_id: a.id }, [OrderStatus.READY]);
      const t = monter({ livreurs: [a], courses: [c], commandes, livraisons });

      await expect(t.echouer(a, livraisons[0].id, CLIENT_ABSENT)).rejects.toThrow('La course doit être en phase IN_DELIVERY');

      expect(livraisons[0].statut).toBe(DeliveryStatut.PENDING);
      expect(commandes[0].status).toBe(OrderStatus.READY);
      expect(c.statut).toBe(statut);
    },
  );

  it('regroupement : la livraison passe à la course de B juste après la lecture, la commande de B reste intacte', async () => {
    const a = livreur();
    const b = livreur();
    // Le regroupement ne déplace des livraisons qu'entre courses pas encore récupérées.
    const { course: deA, commandes, livraisons } = courseAvecCommandes(
      { statut: CourseStatut.ACCEPTED, deliverer_id: a.id },
      [OrderStatus.READY],
    );
    const deB = course({ statut: CourseStatut.ACCEPTED, deliverer_id: b.id });
    const t = monter({ livreurs: [a, b], courses: [deA, deB], commandes, livraisons });
    t.apresLaLecture(() => {
      livraisons[0].course_id = deB.id;
    });

    await expect(t.echouer(a, livraisons[0].id, CLIENT_ABSENT)).rejects.toBeInstanceOf(BadRequestException);

    expect(livraisons[0]).toMatchObject({ course_id: deB.id, statut: DeliveryStatut.PENDING });
    expect(commandes[0].status).toBe(OrderStatus.READY);
  });

  it('livraison remise au même instant (confirmée juste après la lecture) : 400, la commande reste terminée', async () => {
    const a = livreur();
    const { course: c, commandes, livraisons } = courseAvecCommandes(
      { statut: CourseStatut.IN_DELIVERY, deliverer_id: a.id },
      [OrderStatus.PICKED_UP, OrderStatus.PICKED_UP],
    );
    livraisons[0].statut = DeliveryStatut.ARRIVED;
    const t = monter({ livreurs: [a], courses: [c], commandes, livraisons });
    t.apresLaLecture(() => {
      livraisons[0].statut = DeliveryStatut.DELIVERED;
      commandes[0].status = OrderStatus.COMPLETED;
    });

    await expect(t.echouer(a, livraisons[0].id, CLIENT_ABSENT)).rejects.toThrow(
      'Statut delivery attendu PENDING ou IN_ROUTE ou ARRIVED, actuel DELIVERED',
    );

    expect(livraisons[0].statut).toBe(DeliveryStatut.DELIVERED);
    expect(commandes[0].status).toBe(OrderStatus.COMPLETED);
    expect(t.courseEvent.deliveryStatutChanged).not.toHaveBeenCalled();
  });

  it('livraison confiée à B entre la lecture et l’écriture : l’écriture porte le livreur, 403, rien n’est écrit', async () => {
    const a = livreur();
    const b = livreur();
    const { course: deA, commandes, livraisons } = courseAvecCommandes(
      { statut: CourseStatut.IN_DELIVERY, deliverer_id: a.id },
      [OrderStatus.PICKED_UP],
    );
    livraisons[0].statut = DeliveryStatut.IN_ROUTE;
    const deB = course({ statut: CourseStatut.IN_DELIVERY, deliverer_id: b.id });
    const t = monter({ livreurs: [a, b], courses: [deA, deB], commandes, livraisons });
    t.apresLaLecture(() => {
      livraisons[0].course_id = deB.id;
    });

    const refus = t.echouer(a, livraisons[0].id, CLIENT_ABSENT);
    await expect(refus).rejects.toBeInstanceOf(ForbiddenException);
    await expect(refus).rejects.toThrow('Cette livraison ne vous est pas affectée');

    expect(livraisons[0].statut).toBe(DeliveryStatut.IN_ROUTE);
    expect(commandes[0].status).toBe(OrderStatus.PICKED_UP);
  });

  it('la livraison d’un autre, même remise : 403 d’abord (son état n’est pas révélé)', async () => {
    const a = livreur();
    const b = livreur();
    const c = course({ statut: CourseStatut.COMPLETED, deliverer_id: a.id });
    const o = commande({ status: OrderStatus.COMPLETED });
    const l = livraison({ course_id: c.id, order_id: o.id, statut: DeliveryStatut.DELIVERED });
    const t = monter({ livreurs: [a, b], courses: [c], commandes: [o], livraisons: [l] });

    await expect(t.echouer(b, l.id, CLIENT_ABSENT)).rejects.toThrow('Cette livraison ne vous est pas affectée');
    expect(o.status).toBe(OrderStatus.COMPLETED);
  });
});

const CLIENT_ABSENT_NOTE = { reason: DeliveryFailureReason.CLIENT_ABSENT, note: 'Client absent' };

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
  const t = monterBanc({ commandes: [a, b], courses: [k], livraisons: [la, lb], livreurs: [d1] });
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

describe('sur le banc du planificateur', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: MAINTENANT, doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('« Problème » sur une livraison (failDelivery)', () => {
    it('livraison arrivée : échec écrit, commande annulée par le livreur, un événement', async () => {
      const { d1, a, la, t } = enLivraison();

      const reponse = await t.actionsLivraison.failDelivery(la.id, d1.id, CLIENT_ABSENT_NOTE);

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

      expect(await refus(t.actionsLivraison.failDelivery(la.id, d1.id, CLIENT_ABSENT_NOTE))).toBeInstanceOf(BadRequestException);

      expect(la.statut).toBe(DeliveryStatut.DELIVERED);
      expect(a).toMatchObject({ status: OrderStatus.COMPLETED, cancelled_at: null });
      expect(a.cancelled_by).toBeUndefined();
      expect(t.emisSur(CourseChannels.DELIVERY_STATUT_CHANGED)).toHaveLength(evenements);
      expect(k.statut).toBe(CourseStatut.IN_DELIVERY);
    });

    it('course pas encore récupérée (acceptée, au restaurant) ou annulée : 400, rien n’est annulé', async () => {
      for (const statutCourse of [CourseStatut.ACCEPTED, CourseStatut.AT_RESTAURANT, CourseStatut.CANCELLED]) {
        const { d1, a, b, lb, t } = enLivraison({ statutCourse });
        expect(await refus(t.actionsLivraison.failDelivery(lb.id, d1.id, CLIENT_ABSENT_NOTE))).toBeInstanceOf(BadRequestException);
        expect(lb.statut).toBe(DeliveryStatut.PENDING);
        expect(a.status).toBe(OrderStatus.PICKED_UP);
        expect(b.status).toBe(OrderStatus.PICKED_UP);
        expect(t.emisSur(CourseChannels.DELIVERY_STATUT_CHANGED)).toHaveLength(0);
      }
    });

    it('rejeu de « Problème » (réponse perdue, double toucher) : la livraison est rendue, sans second événement', async () => {
      const { d1, la, t } = enLivraison();
      await t.actionsLivraison.failDelivery(la.id, d1.id, CLIENT_ABSENT_NOTE);

      const rejeu = await t.actionsLivraison.failDelivery(la.id, d1.id, CLIENT_ABSENT_NOTE);

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

      expect(await refus(t.actionsLivraison.failDelivery(la.id, d1.id, CLIENT_ABSENT_NOTE))).toBeInstanceOf(BadRequestException);
      expect(la.statut).toBe(DeliveryStatut.DELIVERED);
      expect(a.status).toBe(OrderStatus.COMPLETED);
      expect(t.emisSur(CourseChannels.DELIVERY_STATUT_CHANGED)).toHaveLength(0);
    });

    it('livraison d’un autre livreur : 403', async () => {
      const { la, t } = enLivraison();
      expect((await refus(t.actionsLivraison.failDelivery(la.id, 'un-autre', CLIENT_ABSENT_NOTE))).message).toBe(
        'Cette livraison ne vous est pas affectée',
      );
    });

    it('dernier arrêt en échec : course terminée une seule fois, même si deux fins arrivent ensemble', async () => {
      const { d1, k, la, lb, t } = enLivraison();
      lb.statut = DeliveryStatut.IN_ROUTE;

      await Promise.all([
        t.actionsLivraison.confirmDelivery(la.id, d1.id, { pin: '4821' } as never),
        t.actionsLivraison.failDelivery(lb.id, d1.id, CLIENT_ABSENT_NOTE),
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
});
