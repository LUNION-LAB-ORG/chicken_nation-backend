/**
 * « Plus tard » côté serveur (demande du client du 27/10 : le livreur passe
 * un client qui pose problème, livre les autres, puis revient sur lui).
 * Contrat `tournee-contrat.md`, B2 et B3, tests P8 à P12, sur la base
 * simulée (filtres évalués, transactions annulées en bloc).
 */
import { BadRequestException, ConflictException } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { CourseStatut, DeliveryStatut, OrderStatus } from '@prisma/client';

import { CourseDelivererController } from '../controllers/course-deliverer.controller';
import { COURSE_FULL_INCLUDE } from '../helpers/course.includes';
import { MESSAGE_CLIENT_EN_COURS } from '../helpers/plus-tard.rules';
import { commande, course, livraison, livreur, monterBaseDispatch } from './base-dispatch.simulee-spec';
import { DeliveryActionService } from './delivery-action.service';
import { DeliveryTrackingService } from './delivery-tracking.service';
import { DispatchJournalService } from './dispatch-journal.service';

const PARTI = new Date('2026-10-27T11:40:00.000Z');
const MAINTENANT = new Date('2026-10-27T12:08:00.000Z');

function tournee(statuts: DeliveryStatut[], o: { course?: Record<string, unknown> } = {}) {
  const a = livreur({ protocole_appli: 4 });
  const c = course({
    statut: CourseStatut.IN_DELIVERY,
    deliverer_id: a.id,
    picked_up_at: new Date('2026-10-27T11:38:00.000Z'),
    parti_at: PARTI,
    motif_depart: 'POSITION',
    ...o.course,
  });
  const commandes = statuts.map((s) => commande({ status: s === DeliveryStatut.DELIVERED ? OrderStatus.COMPLETED : OrderStatus.PICKED_UP }));
  const livraisons = commandes.map((cmd, i) =>
    livraison({ course_id: c.id, order_id: cmd.id, sequence_order: i + 1, statut: statuts[i], reportee_at: null, arrived_at: null }),
  );
  const base = monterBaseDispatch({ livreurs: [a], courses: [c], commandes, livraisons });
  const courseEvent = { deliveryStatutChanged: jest.fn(async (_p: Record<string, unknown>) => undefined) };
  const push = { notifyCourseCompleted: jest.fn() };
  const journal = new DispatchJournalService(base.prisma);
  const service = new DeliveryActionService(
    base.prisma,
    courseEvent as never,
    { onComplete: jest.fn() } as never,
    push as never,
    {} as never,
    { avantDemarrageLivraison: jest.fn(async () => undefined) } as never,
    journal,
  );
  const [A, B, C] = livraisons;
  const ordre = () => [...livraisons].sort((x, y) => x.sequence_order - y.sequence_order).map((l) => l.id);
  return { a, c, base, courseEvent, push, service, commandes, livraisons, A, B, C, ordre };
}

describe('route PATCH /courses/deliverer/deliveries/:deliveryId/plus-tard', () => {
  it('existe, avec la garde du livreur et la même validation que les autres routes', () => {
    const proto = CourseDelivererController.prototype as unknown as Record<string, unknown>;
    expect(Reflect.getMetadata(PATH_METADATA, proto.plusTard as object)).toBe('deliveries/:deliveryId/plus-tard');
    expect(Reflect.getMetadata(GUARDS_METADATA, CourseDelivererController)).toHaveLength(1);
  });
});

describe('P9 : effet, événements et journal', () => {
  it('B passée : en attente, en dernier, C démarre ; deux événements ; une ligne au journal ; la course rendue', async () => {
    const t = tournee([DeliveryStatut.DELIVERED, DeliveryStatut.IN_ROUTE, DeliveryStatut.PENDING]);
    const lecture = jest.spyOn(t.base.prisma.course, 'findUniqueOrThrow');

    const rendue: any = await t.service.reporterLivraison(t.B.id, t.a.id, MAINTENANT);

    expect(t.ordre()).toEqual([t.A.id, t.C.id, t.B.id]);
    expect(t.B).toMatchObject({ statut: DeliveryStatut.PENDING, reportee_at: MAINTENANT, arrived_at: null, sequence_order: 3 });
    expect(t.C).toMatchObject({ statut: DeliveryStatut.IN_ROUTE, in_route_at: MAINTENANT, sequence_order: 2 });
    expect(t.courseEvent.deliveryStatutChanged.mock.calls.map(([p]: any[]) => [p.delivery.id, p.previous_statut, p.new_statut])).toEqual([
      [t.B.id, DeliveryStatut.IN_ROUTE, DeliveryStatut.PENDING],
      [t.C.id, DeliveryStatut.PENDING, DeliveryStatut.IN_ROUTE],
    ]);
    const lignes = t.base.journal.filter((l) => l.type === 'LIVRAISON_REPORTEE');
    expect(lignes).toHaveLength(1);
    expect(lignes[0]).toMatchObject({
      source: 'livreur',
      course_id: t.c.id,
      deliverer_id: t.a.id,
      order_id: t.B.order_id,
      details: {
        commande: t.commandes[1].reference,
        statut_avant: DeliveryStatut.IN_ROUTE,
        rang_avant: 2,
        rang_apres: 3,
        arrivee_avant: null,
        suivante: t.commandes[2].reference,
      },
    });
    // La course complète, comme `me/current` (sans le code du client).
    expect(lecture).toHaveBeenLastCalledWith({ where: { id: t.c.id }, include: COURSE_FULL_INCLUDE });
    expect(rendue.deliveries.map((d: any) => d.id)).toEqual([t.A.id, t.C.id, t.B.id]);
    expect(t.push.notifyCourseCompleted).not.toHaveBeenCalled();
  });

  it('arrivée chez le client : l’heure d’arrivée est effacée, l’ancienne va au journal', async () => {
    const t = tournee([DeliveryStatut.ARRIVED, DeliveryStatut.PENDING]);
    const arrivee = new Date('2026-10-27T12:05:00.000Z');
    t.A.arrived_at = arrivee;
    await t.service.reporterLivraison(t.A.id, t.a.id, MAINTENANT);
    expect(t.A).toMatchObject({ statut: DeliveryStatut.PENDING, arrived_at: null, reportee_at: MAINTENANT });
    expect(t.base.journal.find((l) => l.type === 'LIVRAISON_REPORTEE')!.details.arrivee_avant).toBe(arrivee.toISOString());
  });

  it('refus : 409 « Plus d’autre client. », rien n’est écrit, aucun événement', async () => {
    const t = tournee([DeliveryStatut.DELIVERED, DeliveryStatut.IN_ROUTE]);
    await expect(t.service.reporterLivraison(t.B.id, t.a.id, MAINTENANT)).rejects.toThrow(new ConflictException("Plus d'autre client."));
    expect(t.B.statut).toBe(DeliveryStatut.IN_ROUTE);
    expect(t.B.reportee_at).toBeNull();
    expect(t.courseEvent.deliveryStatutChanged).not.toHaveBeenCalled();
  });

  it('rejeu : la course rendue telle quelle, sans événement', async () => {
    const t = tournee([DeliveryStatut.DELIVERED, DeliveryStatut.IN_ROUTE, DeliveryStatut.PENDING]);
    await t.service.reporterLivraison(t.B.id, t.a.id, MAINTENANT);
    t.courseEvent.deliveryStatutChanged.mockClear();
    const rendue: any = await t.service.reporterLivraison(t.B.id, t.a.id, MAINTENANT);
    expect(rendue.id).toBe(t.c.id);
    expect(t.courseEvent.deliveryStatutChanged).not.toHaveBeenCalled();
    expect(t.base.journal.filter((l) => l.type === 'LIVRAISON_REPORTEE')).toHaveLength(1);
  });
});

describe('P8 : un seul passe', () => {
  it('deux « Plus tard » simultanés sur la même livraison : un seul effet', async () => {
    const t = tournee([DeliveryStatut.DELIVERED, DeliveryStatut.IN_ROUTE, DeliveryStatut.PENDING]);
    await Promise.all([t.service.reporterLivraison(t.B.id, t.a.id, MAINTENANT), t.service.reporterLivraison(t.B.id, t.a.id, MAINTENANT)]);
    expect(t.ordre()).toEqual([t.A.id, t.C.id, t.B.id]);
    expect(t.livraisons.map((l) => l.sequence_order).sort()).toEqual([1, 2, 3]);
    expect(t.courseEvent.deliveryStatutChanged).toHaveBeenCalledTimes(2);
    expect(t.base.journal.filter((l) => l.type === 'LIVRAISON_REPORTEE')).toHaveLength(1);
  });

  it('la course a changé sous le verrou (retrait d’une commande qui l’a close) : relue et refusée, rien n’est écrit', async () => {
    const t = tournee([DeliveryStatut.DELIVERED, DeliveryStatut.IN_ROUTE, DeliveryStatut.PENDING]);
    const transaction = t.base.prisma.$transaction;
    jest.spyOn(t.base.prisma, '$transaction').mockImplementationOnce(async (fn: unknown) => {
      // Le détachement passe juste avant : la course n'est plus en livraison.
      t.c.statut = CourseStatut.CANCELLED;
      return transaction(fn);
    });
    await expect(t.service.reporterLivraison(t.B.id, t.a.id, MAINTENANT)).rejects.toThrow(
      new BadRequestException('La course doit être en phase IN_DELIVERY'),
    );
    expect(t.B).toMatchObject({ statut: DeliveryStatut.IN_ROUTE, reportee_at: null, sequence_order: 2 });
    expect(t.C.statut).toBe(DeliveryStatut.PENDING);
    expect(t.courseEvent.deliveryStatutChanged).not.toHaveBeenCalled();
  });

  it('la course est verrouillée d’abord (même ligne que le détachement), sous condition', async () => {
    const t = tournee([DeliveryStatut.IN_ROUTE, DeliveryStatut.PENDING]);
    const ecritures: string[] = [];
    const transaction = t.base.prisma.$transaction;
    jest.spyOn(t.base.prisma, '$transaction').mockImplementationOnce(async (fn: any) =>
      transaction(async (tx: any) => {
        const course = tx.course.updateMany;
        tx.course.updateMany = jest.fn(async (args: any) => {
          ecritures.push(`course:${JSON.stringify(args.where)}`);
          return course(args);
        });
        const livraisons = tx.delivery.updateMany;
        tx.delivery.updateMany = jest.fn(async (args: any) => {
          ecritures.push('livraison');
          return livraisons(args);
        });
        return fn(tx);
      }),
    );
    await t.service.reporterLivraison(t.A.id, t.a.id, MAINTENANT);
    expect(ecritures[0]).toBe(
      `course:${JSON.stringify({ id: t.c.id, deliverer_id: t.a.id, statut: CourseStatut.IN_DELIVERY, parti_at: { not: null } })}`,
    );
    expect(ecritures.slice(1).every((e) => e === 'livraison')).toBe(true);
  });
});

describe('P10 : redémarrage de la livraison reportée', () => {
  it('« en route » de nouveau : le code n’est pas renvoyé par WhatsApp ; une livraison jamais reportée le reçoit', async () => {
    const notifier = jest.fn(async () => undefined);
    const prisma = {
      order: { findUnique: jest.fn(async () => ({ id: 'o1', customer_id: 'client-1' })) },
      course: { findUnique: jest.fn(async () => null) },
    };
    const suivi = new DeliveryTrackingService(prisma as never, { emitToUser: jest.fn() } as never, {} as never, { notifier } as never);
    const payload = (reportee_at: Date | null) => ({
      delivery: { id: 'd1', order_id: 'o1', course_id: 'k1', reportee_at } as never,
      course_id: 'k1',
      course_reference: 'CRS-K1',
      restaurant_id: 'resto',
      previous_statut: DeliveryStatut.PENDING,
      new_statut: DeliveryStatut.IN_ROUTE,
    });
    await suivi.onDeliveryStatutChanged(payload(new Date('2026-10-27T12:00:00.000Z')));
    expect(notifier).not.toHaveBeenCalled();
    await suivi.onDeliveryStatutChanged(payload(null));
    expect(notifier).toHaveBeenCalledWith('o1');
  });

  it('redémarrée par le livreur : la marque « reportée » reste, l’heure de départ est réécrite', async () => {
    const t = tournee([DeliveryStatut.DELIVERED, DeliveryStatut.IN_ROUTE, DeliveryStatut.PENDING]);
    await t.service.reporterLivraison(t.B.id, t.a.id, MAINTENANT);
    t.C.statut = DeliveryStatut.DELIVERED;
    expect(t.B.in_route_at).toBeNull();
    await t.service.startDelivery(t.B.id, t.a.id);
    expect(t.B).toMatchObject({ statut: DeliveryStatut.IN_ROUTE, reportee_at: MAINTENANT, in_route_at: expect.any(Date) });
  });
});

describe('P11 : jamais deux livraisons en route', () => {
  it('démarrer une livraison quand une autre est en route : 409 « Termine d’abord le client en cours. »', async () => {
    const t = tournee([DeliveryStatut.IN_ROUTE, DeliveryStatut.PENDING]);
    await expect(t.service.startDelivery(t.B.id, t.a.id)).rejects.toThrow(new ConflictException(MESSAGE_CLIENT_EN_COURS));
    expect(MESSAGE_CLIENT_EN_COURS).toBe("Termine d'abord le client en cours.");
    expect(t.B.statut).toBe(DeliveryStatut.PENDING);
    expect(t.courseEvent.deliveryStatutChanged).not.toHaveBeenCalled();
  });

  it('arrivée chez un autre client : même refus ; la sienne déjà en route : rendue telle quelle', async () => {
    const t = tournee([DeliveryStatut.ARRIVED, DeliveryStatut.PENDING]);
    await expect(t.service.startDelivery(t.B.id, t.a.id)).rejects.toThrow(new ConflictException(MESSAGE_CLIENT_EN_COURS));
    const u = tournee([DeliveryStatut.IN_ROUTE, DeliveryStatut.PENDING]);
    await expect(u.service.startDelivery(u.A.id, u.a.id)).resolves.toMatchObject({ id: u.A.id, statut: DeliveryStatut.IN_ROUTE });
  });

  it('la précédente livrée : la suivante démarre', async () => {
    const t = tournee([DeliveryStatut.DELIVERED, DeliveryStatut.PENDING]);
    await expect(t.service.startDelivery(t.B.id, t.a.id)).resolves.toMatchObject({ id: t.B.id, statut: DeliveryStatut.IN_ROUTE });
    expect(t.courseEvent.deliveryStatutChanged).toHaveBeenCalledTimes(1);
  });
});

describe('P12 : heure d’arrivée au démarrage d’un 2e arrêt', () => {
  const RESTAURANT = { latitude: 5.286, longitude: -3.9737 };
  const CHEZ_A = { lat: 5.286, lng: -3.946 };

  function suivi(derniere: { lat: number; lng: number; a: Date } | null) {
    const appels: { originLat: number; originLng: number }[] = [];
    const maps = {
      getDirections: jest.fn(async (p: { originLat: number; originLng: number }) => {
        appels.push({ originLat: p.originLat, originLng: p.originLng });
        const depuisRestaurant = p.originLat === RESTAURANT.latitude && p.originLng === RESTAURANT.longitude;
        return { legs: [{ durationSeconds: depuisRestaurant ? 1500 : 180 }], stopsSeconds: 0 };
      }),
    };
    const coursePrisma = {
      id: 'c1',
      deliverer_id: 'liv1',
      parti_at: PARTI,
      restaurant: RESTAURANT,
      deliverer: derniere
        ? { last_location: { lat: derniere.lat, lng: derniere.lng, precision_m: 10 }, last_location_at: derniere.a }
        : { last_location: null, last_location_at: null },
      deliveries: [{ statut: DeliveryStatut.IN_ROUTE, order: { id: 'oB', customer_id: 'cliB', address: { latitude: 5.286, longitude: -3.937 } } }],
    };
    const emis: any[] = [];
    const service = new DeliveryTrackingService(
      {
        order: { findUnique: jest.fn(async () => ({ id: 'oB', customer_id: 'cliB' })) },
        course: { findUnique: jest.fn(async () => coursePrisma), findFirst: jest.fn(async () => coursePrisma) },
      } as never,
      { emitToUser: jest.fn((_u: string, _r: string, canal: string, charge: any) => emis.push({ canal, charge })) } as never,
      maps as never,
      { notifier: jest.fn() } as never,
    );
    const demarrer = () =>
      service.onDeliveryStatutChanged({
        delivery: { id: 'dB', order_id: 'oB', course_id: 'c1', reportee_at: null } as never,
        course_id: 'c1',
        course_reference: 'CRS',
        restaurant_id: 'r',
        previous_statut: DeliveryStatut.PENDING,
        new_statut: DeliveryStatut.IN_ROUTE,
      });
    return { service, appels, emis, demarrer };
  }

  it('course partie, position du livreur de moins de 2 min : calculée depuis lui, pas depuis le restaurant', async () => {
    const s = suivi({ ...CHEZ_A, a: new Date(Date.now() - 30_000) });
    await s.demarrer();
    expect(s.appels).toEqual([{ originLat: CHEZ_A.lat, originLng: CHEZ_A.lng }]);
    expect(s.emis.find((e) => e.canal === 'delivery:statut:changed').charge.etaMin).toBe(3);
  });

  it('position trop ancienne : depuis le restaurant, et ce calcul n’est pas gardé (la position suivante recalcule)', async () => {
    const s = suivi({ ...CHEZ_A, a: new Date(Date.now() - 10 * 60_000) });
    await s.demarrer();
    await s.service.onDelivererLocation({ delivererId: 'liv1', lat: CHEZ_A.lat, lng: CHEZ_A.lng, heading: null, speedKmh: null, ts: 'x' } as never);
    expect(s.appels).toEqual([
      { originLat: RESTAURANT.latitude, originLng: RESTAURANT.longitude },
      { originLat: CHEZ_A.lat, originLng: CHEZ_A.lng },
    ]);
    expect(s.emis.find((e) => e.canal === 'delivery:location').charge.etaMin).toBe(3);
  });
});
