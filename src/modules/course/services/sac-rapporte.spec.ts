/**
 * « SAC RAPPORTÉ » (demande du 28/10) :
 * POST /courses/operations/commandes/:orderId/sac-rapporte, et
 * GET /courses/deliverer/me/sacs-a-rapporter pour le rappel de l'appli.
 *
 * Après « Annuler » du livreur (27/10), la commande reste en livraison : le
 * sac est chez lui. Quand il le rapporte, la caisse touche « Sac rapporté » :
 * la commande redevient prête (claim atomique), la livraison annulée est
 * copiée au journal (SAC_RAPPORTE) puis supprimée, les frais de l'ancienne
 * course sont recalculés, dans UNE transaction. Le planificateur, inchangé,
 * la reprend au passage suivant dans une course NEUVE.
 *
 * Banc : les VRAIS services (livraisons, « Annuler », planificateur, offres,
 * journal) sur la base simulée du planificateur ; les sockets passent par les
 * VRAIS services de diffusion (commande et course) sur une passerelle notée.
 */
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  CourseStatut,
  DeliveryFailureReason,
  DeliveryService,
  DeliveryStatut,
  EntityStatus,
  OrderStatus,
  UserRole,
  UserType,
} from '@prisma/client';

import { UserRolesGuard } from 'src/modules/auth/guards/user-roles.guard';
import { OrderChannels } from 'src/modules/order/enums/order-channels';
import { enrichirCommandesOperations } from 'src/modules/order/helpers/suivi-operations.rules';
import { OrderWebSocketService } from 'src/modules/order/websockets/order-websocket.service';

import { CourseDelivererController } from '../controllers/course-deliverer.controller';
import { CourseOperationsController } from '../controllers/course-operations.controller';
import { CourseChannels } from '../enums/course-channels';
import { CourseLue, construireTableau } from '../helpers/tableau-livraison.rules';
import { OrderBridgeListenerService } from '../listeners/order-bridge.listener.service';
import { CourseWebSocketService } from '../websockets/course-websocket.service';
import { course, livraison, livreur, RESTO } from './base-dispatch.simulee-spec';
import { AU_COMPTOIR, avant, B, MAINTENANT, monter as monterBanc, Options, prete } from './banc-planificateur.simulee-spec';
import { DeliveryActionService } from './delivery-action.service';
import { DispatchJournalService } from './dispatch-journal.service';
import { SacRapporteService } from './sac-rapporte.service';

const CLIENT_ABSENT = { reason: DeliveryFailureReason.CLIENT_ABSENT, note: 'Client absent' };

const CAISSIERE = { id: 'u-caisse', type: UserType.RESTAURANT, role: UserRole.CAISSIER, restaurant_id: RESTO };
const ADMIN = { id: 'u-admin', type: UserType.BACKOFFICE, role: UserRole.ADMIN, restaurant_id: null };
const CAISSIERE_AILLEURS = { id: 'u-ailleurs', type: UserType.RESTAURANT, role: UserRole.CAISSIER, restaurant_id: 'resto-autre' };
const MANAGER_SANS_RESTO = { id: 'u-sans', type: UserType.RESTAURANT, role: UserRole.MANAGER, restaurant_id: null };

/**
 * Course partie de deux arrêts, livreur Koffi : A en route (payée en ligne,
 * code 4821), B en attente (espèces). `seulementA` : un seul client.
 */
function enTournee(o: { seulementA?: boolean; options?: Options; surchargeA?: Record<string, unknown> } = {}) {
  const d1 = livreur({ ...AU_COMPTOIR, first_name: 'Koffi', last_name: 'Yao', last_available_at: null, protocole_appli: 4 });
  const d2 = livreur({ ...AU_COMPTOIR, first_name: 'Awa', last_available_at: avant(300), protocole_appli: 4 });
  const a = prete({
    status: OrderStatus.PICKED_UP,
    picked_up_at: avant(600),
    ready_at: avant(1200),
    paied: true,
    recovery_code: '4821',
    customer_id: 'client-a',
    batch_id: 'lot-ancien',
    ...o.surchargeA,
  });
  const b = prete({ address: B, status: OrderStatus.PICKED_UP, picked_up_at: avant(600), paied: false, recovery_code: '7733' });
  const k = course({
    statut: CourseStatut.IN_DELIVERY,
    deliverer_id: d1.id,
    assigned_at: avant(1200),
    picked_up_at: avant(600),
    parti_at: avant(590),
    total_delivery_fee: o.seulementA ? 1000 : 2000,
  });
  const la = livraison({
    course_id: k.id,
    order_id: a.id,
    sequence_order: 1,
    statut: DeliveryStatut.IN_ROUTE,
    in_route_at: avant(590),
    delivery_pin: '4821',
    customer_rating: null,
    customer_rating_note: null,
  });
  const lb = livraison({ course_id: k.id, order_id: b.id, sequence_order: 2, delivery_pin: '7733' });
  const t = monterBanc(
    { commandes: o.seulementA ? [a] : [a, b], courses: [k], livraisons: o.seulementA ? [la] : [la, lb], livreurs: [d1, d2] },
    o.options,
  );

  const file = { onComplete: jest.fn(async () => undefined) };
  const livraisons = new DeliveryActionService(
    t.base.prisma,
    t.courseEvent,
    file as never,
    t.push as never,
    {} as never,
    t.depart,
    new DispatchJournalService(t.base.prisma),
  );
  // Passerelle des sockets : les VRAIS services de diffusion s'en servent.
  const passerelle = {
    emitToUser: jest.fn(),
    emitToBackoffice: jest.fn(),
    emitToRestaurant: jest.fn(),
    emitToDeliverer: jest.fn(),
  };
  const pushLivreur = { notifySacRendu: jest.fn() };
  const service = new SacRapporteService(
    t.base.prisma,
    t.courseEvent,
    new CourseWebSocketService(passerelle as never),
    new OrderWebSocketService(passerelle as never),
    pushLivreur as never,
  );
  const operations = new CourseOperationsController(t.requetes, t.actions, service);
  const appliLivreur = new CourseDelivererController(t.actions, livraisons, t.requetes, {} as never, t.depart, service);

  /** Ce que fait la route : compte lu du jeton, identifiant de l'URL, corps vide. */
  const geste = (orderId: string, user: Record<string, unknown> = CAISSIERE) =>
    operations.sacRapporte({ user } as never, orderId);
  /** « Annuler » du livreur (feuille « Problème »), route du 27/10. */
  const annuler = (deliveryId: string, corps: Record<string, unknown> = CLIENT_ABSENT) =>
    appliLivreur.annulerLivraison(d1 as never, deliveryId, corps as never);
  const socketsVers = (methode: keyof typeof passerelle, canal: string) =>
    passerelle[methode].mock.calls.filter((c: unknown[]) => c.includes(canal));
  return { d1, d2, a, b, k, la, lb, t, file, service, operations, appliLivreur, passerelle, pushLivreur, geste, annuler, socketsVers };
}

async function refus(promesse: Promise<unknown>) {
  try {
    await promesse;
  } catch (e) {
    return e as Error;
  }
  throw new Error('La promesse devait être rejetée');
}

beforeEach(() => {
  jest.useFakeTimers({ now: MAINTENANT, doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('« Sac rapporté » : la commande redevient prête et repart dans une nouvelle course', () => {
  it('cas normal, course terminée (un client) : prête, livraison copiée au journal puis supprimée, frais recalculés', async () => {
    const { d1, a, k, la, t, geste, annuler } = enTournee({ seulementA: true });
    await annuler(la.id);
    expect(k.statut).toBe(CourseStatut.COMPLETED);
    const pretAvant = a.ready_at;

    const reponse = await geste(a.id);

    expect(reponse).toEqual({
      order_id: a.id,
      reference: a.reference,
      status: OrderStatus.READY,
      livreur: { id: d1.id, prenom: 'Koffi' },
      deja: false,
    });
    // Commande : prête, plus de retrait, fraîche pour le planificateur ; rien d'autre.
    expect(a).toMatchObject({ status: OrderStatus.READY, picked_up_at: null, updated_at: MAINTENANT, paied: true, cancelled_at: null });
    expect(a.ready_at).toEqual(pretAvant);
    // Lot de l'ancien regroupement effacé : la commande repart (v1 comprise).
    expect(a.batch_id).toBeNull();
    // Livraison supprimée : la commande n'a plus de livraison.
    expect(t.base.livraisons.find((l) => l.id === la.id)).toBeUndefined();
    expect(t.base.livraisons.filter((l) => l.order_id === a.id)).toHaveLength(0);
    // Copie complète au journal, sans le code du client.
    const [copie] = t.journalDe('SAC_RAPPORTE');
    expect(t.journalDe('SAC_RAPPORTE')).toHaveLength(1);
    expect(copie).toMatchObject({
      type: 'SAC_RAPPORTE',
      motif: DeliveryFailureReason.CLIENT_ABSENT,
      source: 'caisse',
      restaurant_id: RESTO,
      course_id: k.id,
      deliverer_id: d1.id,
      order_id: a.id,
      details: {
        commande: a.reference,
        course_reference: k.reference,
        failed_at: MAINTENANT.toISOString(),
        failure_note: 'Client absent',
        in_route_at: avant(590).toISOString(),
        arrived_at: null,
        sequence_order: 1,
        customer_rating: null,
        customer_rating_note: null,
        lot: 'lot-ancien',
        par: { id: CAISSIERE.id, role: UserRole.CAISSIER },
      },
    });
    expect(JSON.stringify(copie)).not.toContain('4821');
    // La ligne LIVRAISON_ANNULEE de la veille reste.
    expect(t.journalDe('LIVRAISON_ANNULEE')).toHaveLength(1);
    // Ancienne course : frais recalculés (plus rien à livrer), statut inchangé.
    expect(k.total_delivery_fee).toBe(0);
    expect(k.statut).toBe(CourseStatut.COMPLETED);
  });

  it('l’administrateur (siège) : tout le réseau, source « admin »', async () => {
    const { a, la, t, geste, annuler } = enTournee({ seulementA: true });
    await annuler(la.id);

    const reponse = await geste(a.id, ADMIN);

    expect(reponse).toMatchObject({ status: OrderStatus.READY, deja: false });
    expect(t.journalDe('SAC_RAPPORTE')[0]).toMatchObject({ source: 'admin', details: expect.objectContaining({ par: { id: ADMIN.id, role: UserRole.ADMIN } }) });
  });

  it('reprise : le passage suivant du planificateur crée une course NEUVE, livraison en attente, code du client gardé', async () => {
    const { a, k, la, t, geste, annuler } = enTournee({ seulementA: true });
    await annuler(la.id);
    // Avant le geste : le planificateur ne la prend pas (elle a sa livraison).
    await t.passer();
    expect(t.journalDe('COURSE_CREEE')).toHaveLength(0);

    await geste(a.id);
    // L'événement de statut demande le passage (PlanificateurListener) : commande prête, à livrer, flotte interne.
    const [statut] = t.emisSur(OrderChannels.ORDER_STATUS_UPDATED);
    expect(statut.order).toMatchObject({ id: a.id, status: OrderStatus.READY, type: 'DELIVERY', delivery_service: DeliveryService.CHICKEN_NATION });
    await t.passer();

    expect(t.journalDe('COURSE_CREEE')).toHaveLength(1);
    const neuve = t.coursesOuvertes().find((c) => c.id !== k.id)!;
    expect(neuve).toBeDefined();
    expect(neuve.reference).not.toBe(k.reference);
    expect(neuve.pickup_code).toMatch(/^\d{3}$/);
    expect(t.livraisonsDe(neuve.id)).toEqual([
      expect.objectContaining({ order_id: a.id, statut: DeliveryStatut.PENDING, delivery_pin: '4821' }),
    ]);
    // Jamais l'ancienne course.
    expect(t.livraisonsDe(k.id)).toHaveLength(0);
    expect(k.statut).toBe(CourseStatut.COMPLETED);
  });

  it('reprise, restaurant en v1 : le regroupement (tryGroupOrder) la prend, lot effacé', async () => {
    const { a, la, t, geste, annuler } = enTournee({ seulementA: true, options: { reglages: { 'course.planificateur': 'v1' } } });
    await annuler(la.id);

    await geste(a.id);
    const pont = new OrderBridgeListenerService(t.regroupement as never, t.settings);
    const [statut] = t.emisSur(OrderChannels.ORDER_STATUS_UPDATED);
    await pont.onOrderStatusUpdated(statut);

    expect(t.regroupement.tryGroupOrder).toHaveBeenCalledWith(a.id);
    expect(a.batch_id).toBeNull();
  });

  it('course encore en livraison (client B restant) : seule A repart, B et la course ne bougent pas', async () => {
    const { a, b, k, la, lb, t, geste, annuler } = enTournee();
    await annuler(la.id);
    expect(k.statut).toBe(CourseStatut.IN_DELIVERY);

    await geste(a.id);

    expect(a.status).toBe(OrderStatus.READY);
    expect(b).toMatchObject({ status: OrderStatus.PICKED_UP, picked_up_at: avant(600) });
    expect(lb.statut).toBe(DeliveryStatut.PENDING);
    expect(t.livraisonsDe(k.id).map((l) => l.order_id)).toEqual([b.id]);
    expect(k.statut).toBe(CourseStatut.IN_DELIVERY);
    // Frais : B seule.
    expect(k.total_delivery_fee).toBe(1000);

    // A repart dans une nouvelle course, jamais dans celle de Koffi (partie).
    await t.passer();
    const neuve = t.coursesOuvertes().find((c) => c.id !== k.id)!;
    expect(t.livraisonsDe(neuve.id).map((l) => l.order_id)).toEqual([a.id]);
    expect(t.livraisonsDe(k.id).map((l) => l.order_id)).toEqual([b.id]);
  });

  it('rejeu (seconde caisse, réponse perdue) : 200 « deja », rien n’est réécrit ni émis', async () => {
    const { d1, a, la, t, geste, annuler, passerelle, pushLivreur } = enTournee({ seulementA: true });
    await annuler(la.id);
    await geste(a.id);
    const emissions = t.emis.length;
    const sockets = Object.values(passerelle).reduce((n, f) => n + f.mock.calls.length, 0);

    const rejeu = await geste(a.id);

    expect(rejeu).toEqual({ order_id: a.id, reference: a.reference, status: OrderStatus.READY, livreur: { id: d1.id, prenom: 'Koffi' }, deja: true });
    expect(t.journalDe('SAC_RAPPORTE')).toHaveLength(1);
    expect(t.emis.length).toBe(emissions);
    expect(Object.values(passerelle).reduce((n, f) => n + f.mock.calls.length, 0)).toBe(sockets);
    expect(pushLivreur.notifySacRendu).toHaveBeenCalledTimes(1);
  });

  describe('concurrence : un seul gagne', () => {
    it('double toucher (deux caisses au même instant) : une écriture, un « deja », un seul événement', async () => {
      const { a, la, t, geste, annuler, pushLivreur, socketsVers } = enTournee({ seulementA: true });
      await annuler(la.id);
      // En base, la ligne de la commande est verrouillée par la première
      // transaction : la seconde attend sa fin. Le banc sérialise donc les
      // transactions, comme le verrou de ligne.
      const transaction = t.base.prisma.$transaction.getMockImplementation()!;
      let file: Promise<unknown> = Promise.resolve();
      t.base.prisma.$transaction.mockImplementation((arg: unknown) => {
        const tour = file.then(() => transaction(arg));
        file = tour.catch(() => undefined);
        return tour;
      });

      const [x, y] = await Promise.all([geste(a.id), geste(a.id)]);

      expect([x.deja, y.deja].sort()).toEqual([false, true]);
      expect(a.status).toBe(OrderStatus.READY);
      expect(t.journalDe('SAC_RAPPORTE')).toHaveLength(1);
      expect(t.emisSur(OrderChannels.ORDER_STATUS_UPDATED)).toHaveLength(1);
      expect(socketsVers('emitToDeliverer', CourseChannels.SAC_RAPPORTE)).toHaveLength(1);
      expect(pushLivreur.notifySacRendu).toHaveBeenCalledTimes(1);
    });

    it('« Annuler la commande » de l’admin au même instant : la commande reste annulée, 409, rien n’est écrit', async () => {
      const { a, la, t, geste, annuler, passerelle, pushLivreur } = enTournee({ seulementA: true });
      await annuler(la.id);
      // L'annulation de l'admin passe juste avant l'écriture du geste.
      const transaction = t.base.prisma.$transaction.getMockImplementation()!;
      t.base.prisma.$transaction.mockImplementationOnce(async (arg: unknown) => {
        Object.assign(a, { status: OrderStatus.CANCELLED, cancelled_at: MAINTENANT, cancelled_by: 'admin' });
        return transaction(arg);
      });

      const e = await refus(geste(a.id));

      expect(e).toBeInstanceOf(ConflictException);
      expect(e.message).toBe('Commande annulée.');
      expect(a.status).toBe(OrderStatus.CANCELLED);
      expect(la.statut).toBe(DeliveryStatut.FAILED);
      expect(t.base.livraisons).toContain(la);
      expect(t.journalDe('SAC_RAPPORTE')).toHaveLength(0);
      expect(t.emisSur(OrderChannels.ORDER_STATUS_UPDATED)).toHaveLength(0);
      expect(passerelle.emitToDeliverer).not.toHaveBeenCalled();
      expect(pushLivreur.notifySacRendu).not.toHaveBeenCalled();
    });

    it('livraison disparue entre le retour à « prête » et sa suppression : tout est annulé (commande toujours en livraison)', async () => {
      const { a, la, t, geste, annuler } = enTournee({ seulementA: true });
      await annuler(la.id);
      const transaction = t.base.prisma.$transaction.getMockImplementation()!;
      t.base.prisma.$transaction.mockImplementation((arg: unknown) =>
        transaction(async (tx: any) =>
          (arg as (tx: unknown) => Promise<unknown>)({ ...tx, delivery: { ...tx.delivery, deleteMany: jest.fn(async () => ({ count: 0 })) } }),
        ),
      );

      const e = await refus(geste(a.id));

      expect(e).toBeInstanceOf(ConflictException);
      expect(a).toMatchObject({ status: OrderStatus.PICKED_UP, picked_up_at: avant(600), batch_id: 'lot-ancien' });
      expect(t.base.livraisons).toContain(la);
      expect(t.journalDe('SAC_RAPPORTE')).toHaveLength(0);
      expect(t.emisSur(OrderChannels.ORDER_STATUS_UPDATED)).toHaveLength(0);
    });
  });

  describe('refus', () => {
    it('commande inconnue ou supprimée : 404 « Commande introuvable. »', async () => {
      const { a, la, geste, annuler } = enTournee({ seulementA: true });
      await annuler(la.id);
      const inconnue = await refus(geste('00000000-0000-4000-8000-000000000000'));
      expect(inconnue).toBeInstanceOf(NotFoundException);
      expect(inconnue.message).toBe('Commande introuvable.');

      a.entity_status = EntityStatus.DELETED;
      const supprimee = await refus(geste(a.id));
      expect(supprimee).toBeInstanceOf(NotFoundException);
      expect(supprimee.message).toBe('Commande introuvable.');
    });

    it('caissière d’un autre restaurant, ou compte de restaurant sans restaurant : 403, rien n’est écrit', async () => {
      const { a, la, t, geste, annuler } = enTournee({ seulementA: true });
      await annuler(la.id);
      for (const user of [CAISSIERE_AILLEURS, MANAGER_SANS_RESTO]) {
        const e = await refus(geste(a.id, user));
        expect(e).toBeInstanceOf(ForbiddenException);
        expect(e.message).toBe("Cette commande n'est pas celle de votre restaurant.");
      }
      expect(a.status).toBe(OrderStatus.PICKED_UP);
      expect(la.statut).toBe(DeliveryStatut.FAILED);
      expect(t.journalDe('SAC_RAPPORTE')).toHaveLength(0);
    });

    it('livraison encore en cours, ou livrée : 409 « Pas de sac à rapporter pour cette commande. »', async () => {
      const { d1, a, la, t, geste } = enTournee({ seulementA: true });
      const enCours = await refus(geste(a.id));
      expect(enCours).toBeInstanceOf(ConflictException);
      expect(enCours.message).toBe('Pas de sac à rapporter pour cette commande.');
      expect(la.statut).toBe(DeliveryStatut.IN_ROUTE);

      la.statut = DeliveryStatut.ARRIVED;
      await t.actionsLivraison.confirmDelivery(la.id, d1.id, { pin: '4821' } as never);
      expect(a.status).toBe(OrderStatus.COMPLETED);
      const livree = await refus(geste(a.id));
      expect(livree).toBeInstanceOf(ConflictException);
      expect(livree.message).toBe('Pas de sac à rapporter pour cette commande.');
      expect(t.journalDe('SAC_RAPPORTE')).toHaveLength(0);
    });

    it('commande prête au comptoir : 409 « Pas de sac à rapporter pour cette commande. »', async () => {
      const { b, lb, geste } = enTournee();
      b.status = OrderStatus.READY;
      b.picked_up_at = null;
      const e = await refus(geste(b.id));
      expect(e).toBeInstanceOf(ConflictException);
      expect(e.message).toBe('Pas de sac à rapporter pour cette commande.');
      expect(lb.statut).toBe(DeliveryStatut.PENDING);
    });

    it('commande annulée (dont les anciennes livraisons en échec d’avant le 27/10) : 409 « Commande annulée. »', async () => {
      const { a, la, t, geste } = enTournee({ seulementA: true });
      // Avant le 27/10, `/fail` annulait aussi la commande.
      Object.assign(la, { statut: DeliveryStatut.FAILED, failed_at: avant(86_400 * 3), failure_reason: DeliveryFailureReason.CLIENT_ABSENT });
      Object.assign(a, { status: OrderStatus.CANCELLED, cancelled_at: avant(86_400 * 3), cancelled_by: 'deliverer' });

      const e = await refus(geste(a.id));

      expect(e).toBeInstanceOf(ConflictException);
      expect(e.message).toBe('Commande annulée.');
      expect(t.base.livraisons).toContain(la);
      expect(t.journalDe('SAC_RAPPORTE')).toHaveLength(0);
    });

    it('course confiée à Turbo : 409 « Pas de sac à rapporter pour cette commande. »', async () => {
      const { a, k, la, geste, annuler } = enTournee({ seulementA: true });
      await annuler(la.id);
      k.turbo_escalated_at = avant(60);
      const e = await refus(geste(a.id));
      expect(e).toBeInstanceOf(ConflictException);
      expect(e.message).toBe('Pas de sac à rapporter pour cette commande.');
      expect(a.status).toBe(OrderStatus.PICKED_UP);
    });

    it('rôles : ADMIN, MANAGER, ASSISTANT_MANAGER, CAISSIER ; jamais le centre d’appels, la cuisine, le suivi des livraisons', () => {
      const passe = (role: UserRole) =>
        new UserRolesGuard(new Reflector()).canActivate({
          getHandler: () => CourseOperationsController.prototype.sacRapporte,
          getClass: () => CourseOperationsController,
          switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
        } as never);
      const admis = [UserRole.ADMIN, UserRole.MANAGER, UserRole.ASSISTANT_MANAGER, UserRole.CAISSIER];
      expect(Object.values(UserRole).filter(passe).sort()).toEqual([...admis].sort());
      for (const role of [UserRole.CALL_CENTER, UserRole.CUISINE, UserRole.LIVRAISON_OPS, UserRole.MARKETING]) {
        expect(passe(role)).toBe(false);
      }
    });
  });

  it('événements : statut « prête » (client, siège, restaurant sans code), course au siège et au restaurant, livreur prévenu ; jamais DELIVERY_STATUT_CHANGED', async () => {
    const { d1, a, k, la, t, geste, annuler, passerelle, pushLivreur, socketsVers } = enTournee({ seulementA: true });
    await annuler(la.id);
    const livraisonsAvant = t.emisSur(CourseChannels.DELIVERY_STATUT_CHANGED).length;
    passerelle.emitToDeliverer.mockClear();

    await geste(a.id);

    // Commande : même chemin que OrderService.updateStatus.
    const [client] = socketsVers('emitToUser', OrderChannels.ORDER_STATUS_UPDATED);
    expect(client).toEqual([
      'client-a',
      'customer',
      OrderChannels.ORDER_STATUS_UPDATED,
      expect.objectContaining({ message: 'Commande prête', previousStatus: OrderStatus.PICKED_UP, order: expect.objectContaining({ id: a.id, status: OrderStatus.READY }) }),
    ]);
    const [siege] = socketsVers('emitToBackoffice', OrderChannels.ORDER_STATUS_UPDATED);
    const [resto] = socketsVers('emitToRestaurant', OrderChannels.ORDER_STATUS_UPDATED);
    expect(siege[1]).toMatchObject({ message: 'Commande prête', order: { id: a.id, status: OrderStatus.READY } });
    expect(resto[0]).toBe(RESTO);
    expect(siege[1].order).not.toHaveProperty('recovery_code');
    expect(resto[2].order).not.toHaveProperty('recovery_code');
    // Événement interne : planificateur, regroupement v1, cloche « prête », CRM. Sans jeton : pas de notification au client.
    const internes = t.emisSur(OrderChannels.ORDER_STATUS_UPDATED);
    expect(internes).toHaveLength(1);
    expect(internes[0].order).toMatchObject({ id: a.id, status: OrderStatus.READY });
    expect(internes[0].expo_token).toBeUndefined();
    // Ancienne course : au siège et au restaurant seulement, raison SAC_RAPPORTE.
    const [courseSiege] = socketsVers('emitToBackoffice', CourseChannels.COURSE_STATUT_CHANGED);
    expect(courseSiege[1]).toMatchObject({ reason: 'SAC_RAPPORTE', course: expect.objectContaining({ id: k.id }) });
    expect(socketsVers('emitToRestaurant', CourseChannels.COURSE_STATUT_CHANGED)).toHaveLength(1);
    expect(socketsVers('emitToDeliverer', CourseChannels.COURSE_STATUT_CHANGED)).toHaveLength(0);
    // Livreur : socket et notification « Sac rendu ».
    expect(passerelle.emitToDeliverer.mock.calls).toEqual([
      [d1.id, 'deliverer:sac:rapporte', { order_id: a.id, reference: a.reference }],
    ]);
    expect(pushLivreur.notifySacRendu).toHaveBeenCalledWith({ delivererId: d1.id, orderId: a.id, reference: a.reference });
    // Coupons et points ne bougent pas : aucun changement de livraison annoncé.
    expect(t.emisSur(CourseChannels.DELIVERY_STATUT_CHANGED)).toHaveLength(livraisonsAvant);
  });

  describe('écrans : `sac_a_rapporter` et l’alerte « a annulé »', () => {
    /** Commande telle que `findActiveForOperations` la lit (livraison, course, livreur). */
    const lireCommande = async (t: ReturnType<typeof enTournee>['t'], id: string) =>
      t.base.prisma.order.findUnique({
        where: { id },
        include: { delivery: { include: { course: { include: { deliverer: true } } } } },
      });
    const p = { maintenant: MAINTENANT, fenetreMaxS: 240 };

    it('rempli après « Annuler » (prénom, nom, motif, depuis), `null` en route et après le geste', async () => {
      const { a, la, t, geste, annuler } = enTournee({ seulementA: true });
      const [enRoute] = enrichirCommandesOperations([await lireCommande(t, a.id)], p) as any[];
      expect(enRoute.sac_a_rapporter).toBeNull();

      await annuler(la.id);
      const [annulee] = enrichirCommandesOperations([await lireCommande(t, a.id)], p) as any[];
      expect(annulee.sac_a_rapporter).toEqual({
        livreur: { id: expect.any(String), prenom: 'Koffi', nom: 'Yao' },
        depuis: MAINTENANT.toISOString(),
        motif: DeliveryFailureReason.CLIENT_ABSENT,
      });

      await geste(a.id);
      const [prete] = enrichirCommandesOperations([await lireCommande(t, a.id)], p) as any[];
      expect(prete.sac_a_rapporter).toBeNull();
    });

    it('alerte : `commandes_ids` dans l’ordre des références ; plus d’alerte après le geste', async () => {
      const { d1, a, k, la, t, geste, annuler } = enTournee();
      await annuler(la.id);
      /** La course telle que le tableau la lit (`TableauLivraisonService`). */
      const lue = (): CourseLue => ({
        ...k,
        deliverer: { id: d1.id, first_name: 'Koffi' },
        deliveries: t.livraisonsDe(k.id).map((l) => {
          const o = t.base.commandes.find((c) => c.id === l.order_id)!;
          return {
            statut: l.statut,
            ajoutee_apres_retrait: l.ajoutee_apres_retrait,
            failed_at: l.failed_at ?? null,
            failure_reason: l.failure_reason ?? null,
            order: { id: o.id, reference: o.reference, status: o.status, entity_status: o.entity_status, delivery_service: o.delivery_service },
          };
        }),
      }) as CourseLue;
      const alertes = () =>
        construireTableau({
          maintenant: MAINTENANT,
          reglages: { facteurRetard: 1.5, sansLivreurAlerteMin: 5, attenteAuRestaurantMin: 15, positionExpireeMin: 5 },
          restaurants: [{ id: RESTO, nom: 'Zone 4' }],
          livreurs: [],
          courses: [lue()],
          aEncaisser: [],
          livrees: [],
          planning: { jour: new Date('2026-10-22T00:00:00.000Z'), plans: [], repos: [], absents: [] },
        }).signaux.filter((s) => s.cle === 'LIVRAISON_ANNULEE_PAR_LIVREUR');

      expect(alertes()).toEqual([expect.objectContaining({ commandes: [a.reference], commandes_ids: [a.id] })]);

      await geste(a.id);

      expect(alertes()).toEqual([]);
    });
  });

  describe('appli du livreur : GET /courses/deliverer/me/sacs-a-rapporter', () => {
    it('ses sacs seulement, restaurant et heure ; rien pour un autre livreur ; vide après le geste', async () => {
      const { d1, d2, a, la, appliLivreur, geste, annuler } = enTournee();
      expect(await appliLivreur.sacsARapporter(d1 as never)).toEqual([]);

      await annuler(la.id);

      expect(await appliLivreur.sacsARapporter(d1 as never)).toEqual([
        { order_id: a.id, reference: a.reference, restaurant: { id: RESTO, nom: 'Zone 4' }, depuis: MAINTENANT.toISOString() },
      ]);
      expect(await appliLivreur.sacsARapporter(d2 as never)).toEqual([]);

      await geste(a.id);
      expect(await appliLivreur.sacsARapporter(d1 as never)).toEqual([]);
    });

    it('triés par heure d’annulation ; rien au-delà de 24 h', async () => {
      const { d1, a, b, la, lb, appliLivreur, annuler } = enTournee();
      await annuler(la.id);
      lb.statut = DeliveryStatut.ARRIVED;
      await annuler(lb.id, { reason: DeliveryFailureReason.CLIENT_REFUSED });
      la.failed_at = avant(3600);

      expect((await appliLivreur.sacsARapporter(d1 as never)).map((s: { reference: string }) => s.reference)).toEqual([a.reference, b.reference]);

      la.failed_at = avant(24 * 3600 + 60);
      expect((await appliLivreur.sacsARapporter(d1 as never)).map((s: { reference: string }) => s.reference)).toEqual([b.reference]);
    });
  });
});
