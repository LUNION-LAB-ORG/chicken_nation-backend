/**
 * « Annuler » de la feuille « Problème » du livreur (demande du 27/10) :
 * PATCH /courses/deliverer/deliveries/:deliveryId/annuler, et `/fail` de
 * l'appli déjà installée, qui passe par le même service.
 *
 * Demande du client : la LIVRAISON de ce client est annulée, jamais la
 * commande. La livraison passe en échec (FAILED) avec son motif et sa note ;
 * la commande reste en livraison (PICKED_UP), avec son drapeau « payée » ;
 * aucun paiement, aucun point ni coupon rendu. La course se termine s'il ne
 * reste rien à livrer, sinon la tournée continue. Une ligne LIVRAISON_ANNULEE
 * au journal et un ticket du livreur (priorité haute, commande liée) pour le
 * personnel. Un rejeu ne refait rien.
 *
 * Banc : les VRAIS services (livraisons, journal, planificateur, offres,
 * annulation d'une course) sur la base simulée du planificateur, et le VRAI
 * service des tickets du livreur, branché sur le bus comme dans le serveur.
 */
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { CourseStatut, DeliveryFailureReason, DeliveryStatut, OrderStatus } from '@prisma/client';

import { LivraisonAnnuleeListener } from 'src/modules/support/listeners/livraison-annulee.listener';
import { brancherTickets, CATEGORIE_LIVRAISON } from 'src/modules/support/services/base-tickets.simulee-spec';
import { CategoriesTicketService } from 'src/modules/support/services/categories-ticket.service';
import { DelivererTicketsService } from 'src/modules/support/services/deliverer-tickets.service';
import { TicketEvent } from 'src/modules/support/events/ticket.event';

import { CourseDelivererController } from '../controllers/course-deliverer.controller';
import { CourseChannels } from '../enums/course-channels';
import { LIVRAISON_ANNULEE_PAR_LIVREUR } from '../events/livraison-annulee.event';
import { course, livraison, livreur } from './base-dispatch.simulee-spec';
import { AU_COMPTOIR, avant, B, MAINTENANT, monter as monterBanc, prete } from './banc-planificateur.simulee-spec';
import { DeliveryActionService } from './delivery-action.service';
import { DispatchJournalService } from './dispatch-journal.service';

const CLIENT_ABSENT = { reason: DeliveryFailureReason.CLIENT_ABSENT, note: 'Client absent' };

/**
 * Course partie de deux arrêts : A en route (payée en ligne), B en attente
 * (espèces). Livreur Koffi.
 */
function enTournee(o: { statutCourse?: CourseStatut; categories?: Record<string, unknown>[]; seulementA?: boolean } = {}) {
  const d1 = livreur({ ...AU_COMPTOIR, first_name: 'Koffi', last_available_at: null, protocole_appli: 4 });
  const a = prete({ status: OrderStatus.PICKED_UP, picked_up_at: avant(600), paied: true });
  const b = prete({ address: B, status: OrderStatus.PICKED_UP, picked_up_at: avant(600), paied: false });
  const k = course({
    statut: o.statutCourse ?? CourseStatut.IN_DELIVERY,
    deliverer_id: d1.id,
    assigned_at: avant(1200),
    picked_up_at: avant(600),
    parti_at: avant(590),
  });
  const la = livraison({
    course_id: k.id,
    order_id: a.id,
    sequence_order: 1,
    statut: DeliveryStatut.IN_ROUTE,
    in_route_at: avant(590),
    delivery_pin: '4821',
    customer_rating: null,
  });
  const lb = livraison({ course_id: k.id, order_id: b.id, sequence_order: 2, delivery_pin: '7733' });
  const commandes = o.seulementA ? [a] : [a, b];
  const livraisons = o.seulementA ? [la] : [la, lb];
  const t = monterBanc({ commandes, courses: [k], livraisons, livreurs: [d1] });

  // Le serveur : DeliveryActionService avec son journal, le module support
  // qui écoute l'événement interne et crée le ticket du livreur.
  const file = { onComplete: jest.fn(async () => undefined) };
  const service = new DeliveryActionService(
    t.base.prisma,
    t.courseEvent,
    file as never,
    t.push as never,
    {} as never,
    t.depart,
    new DispatchJournalService(t.base.prisma),
  );
  const controleur = new CourseDelivererController(t.actions, service, t.requetes, {} as never, t.depart);
  const tickets = brancherTickets(t.base.prisma, { commandes: t.base.commandes, livreurs: t.base.livreurs }, o.categories);
  const busTickets = { emit: jest.fn() };
  const ticketsLivreur = new DelivererTicketsService(
    t.base.prisma,
    new TicketEvent(busTickets as never),
    new CategoriesTicketService(t.base.prisma),
    {} as never,
  );
  const ecouteur = new LivraisonAnnuleeListener(ticketsLivreur);
  const enVol: Promise<unknown>[] = [];
  const emettre = t.bus.emit.getMockImplementation()!;
  t.bus.emit.mockImplementation((canal: string, charge: unknown) => {
    const rendu = emettre(canal, charge);
    if (canal === LIVRAISON_ANNULEE_PAR_LIVREUR) enVol.push(ecouteur.creerTicket(charge as never));
    return rendu;
  });
  /** Ce que fait la route : livreur lu du jeton, identifiant de l'URL, corps tel quel. */
  const annuler = async (deliveryId: string, corps: Record<string, unknown> = CLIENT_ABSENT, qui = d1) => {
    const rendue = await controleur.annulerLivraison(qui as never, deliveryId, corps as never);
    await Promise.all(enVol);
    return rendue;
  };
  const echouer = async (deliveryId: string, corps: Record<string, unknown> = CLIENT_ABSENT) => {
    const rendue = await controleur.failDelivery(d1 as never, deliveryId, corps as never);
    await Promise.all(enVol);
    return rendue;
  };
  return { d1, a, b, k, la, lb, t, file, service, controleur, tickets, busTickets, annuler, echouer, enVol };
}

async function refus(promesse: Promise<unknown>) {
  try {
    await promesse;
  } catch (e) {
    return e as Error;
  }
  throw new Error('La promesse devait être rejetée');
}

/** Rien de la commande n'a bougé (statut, annulation, paiement, retrait). */
function commandeIntacte(o: Record<string, any>, paied: boolean) {
  expect(o).toMatchObject({ status: OrderStatus.PICKED_UP, cancelled_at: null, paied });
  expect(o.cancelled_by).toBeUndefined();
  expect(o.cancelled_reason).toBeUndefined();
  expect(o.picked_up_at).toEqual(avant(600));
}

describe('« Annuler » : la livraison de ce client, jamais la commande', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: MAINTENANT, doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('cas normal : livraison en échec avec motif et note, commande toujours en livraison et payée, tournée continue', async () => {
    const { a, k, la, lb, t, tickets, annuler, file } = enTournee();

    const rendue = await annuler(la.id);

    expect(rendue).toMatchObject({
      id: la.id,
      statut: DeliveryStatut.FAILED,
      failure_reason: DeliveryFailureReason.CLIENT_ABSENT,
      failure_note: 'Client absent',
    });
    expect(la.failed_at).toEqual(MAINTENANT);
    commandeIntacte(a, true);
    // Il reste B : la tournée continue.
    expect(k.statut).toBe(CourseStatut.IN_DELIVERY);
    expect(lb.statut).toBe(DeliveryStatut.PENDING);
    expect(file.onComplete).not.toHaveBeenCalled();
    expect(t.emisSur(CourseChannels.DELIVERY_STATUT_CHANGED)).toEqual([
      expect.objectContaining({ previous_statut: DeliveryStatut.IN_ROUTE, new_statut: DeliveryStatut.FAILED }),
    ]);
    // Journal : une ligne, source appli, route et note.
    expect(t.journalDe('LIVRAISON_ANNULEE')).toEqual([
      expect.objectContaining({
        motif: DeliveryFailureReason.CLIENT_ABSENT,
        source: 'appli',
        restaurant_id: k.restaurant_id,
        course_id: k.id,
        deliverer_id: k.deliverer_id,
        order_id: a.id,
        details: { route: 'annuler', note: 'Client absent' },
      }),
    ]);
    // Ticket du livreur, commande liée, priorité haute.
    expect(tickets.fils).toEqual([
      expect.objectContaining({
        subject: 'Livraison annulée : Client absent',
        priority: 'HIGH',
        source: 'mobile_deliverer',
        delivererId: k.deliverer_id,
        orderId: a.id,
        categoryId: CATEGORIE_LIVRAISON.id,
      }),
    ]);
    expect(tickets.messages).toEqual([
      expect.objectContaining({
        body: `Client absent\nCommande ${a.reference} · Course ${k.reference}`,
        authorDelivererId: k.deliverer_id,
        internal: false,
      }),
    ]);
  });

  it('dernier client : course terminée, livreur remis dans la file, commande toujours en livraison (non payée)', async () => {
    const { d1, a, b, k, la, lb, t, annuler, file } = enTournee();
    la.statut = DeliveryStatut.ARRIVED;
    await t.actionsLivraison.confirmDelivery(la.id, d1.id, { pin: '4821' } as never);
    expect(a.status).toBe(OrderStatus.COMPLETED);
    lb.statut = DeliveryStatut.ARRIVED;

    await annuler(lb.id, { reason: DeliveryFailureReason.CLIENT_UNREACHABLE });

    expect(lb.statut).toBe(DeliveryStatut.FAILED);
    commandeIntacte(b, false);
    expect(k.statut).toBe(CourseStatut.COMPLETED);
    expect(file.onComplete).toHaveBeenCalledWith(d1.id);
    expect(t.emisSur(CourseChannels.COURSE_COMPLETED)).toHaveLength(1);
    // La notification de fin de course est gardée (hors demande).
    expect(t.push.notifyCourseCompleted).toHaveBeenCalledTimes(1);
  });

  it('rejeu (réponse perdue) : même réponse, un seul ticket, un seul événement, une seule ligne au journal', async () => {
    const { la, t, tickets, annuler } = enTournee();
    const premiere = await annuler(la.id);

    const rejeu = await annuler(la.id);

    expect(rejeu).toEqual(premiere);
    expect(tickets.fils).toHaveLength(1);
    expect(t.emisSur(CourseChannels.DELIVERY_STATUT_CHANGED)).toHaveLength(1);
    expect(t.emisSur(LIVRAISON_ANNULEE_PAR_LIVREUR)).toHaveLength(1);
    expect(t.journalDe('LIVRAISON_ANNULEE')).toHaveLength(1);
  });

  it('double toucher (deux appels ensemble) : un seul passe, un seul ticket', async () => {
    const { la, t, tickets, annuler } = enTournee();

    const [x, y] = await Promise.all([annuler(la.id), annuler(la.id)]);

    expect(x).toMatchObject({ statut: DeliveryStatut.FAILED });
    expect(y).toMatchObject({ statut: DeliveryStatut.FAILED });
    expect(tickets.fils).toHaveLength(1);
    expect(t.emisSur(CourseChannels.DELIVERY_STATUT_CHANGED)).toHaveLength(1);
    expect(t.journalDe('LIVRAISON_ANNULEE')).toHaveLength(1);
  });

  describe('refus, rien n’est écrit', () => {
    it('livraison inconnue : 404', async () => {
      const { annuler } = enTournee();
      const e = await refus(annuler('00000000-0000-4000-8000-000000000000'));
      expect(e).toBeInstanceOf(NotFoundException);
      expect(e.message).toBe('Delivery non trouvée');
    });

    it('livraison d’un autre livreur : 403', async () => {
      const { a, la, annuler, tickets } = enTournee();
      const autre = livreur();
      const e = await refus(annuler(la.id, CLIENT_ABSENT, autre));
      expect(e).toBeInstanceOf(ForbiddenException);
      expect(e.message).toBe('Cette livraison ne vous est pas affectée');
      expect(la.statut).toBe(DeliveryStatut.IN_ROUTE);
      commandeIntacte(a, true);
      expect(tickets.fils).toHaveLength(0);
    });

    it.each([CourseStatut.ACCEPTED, CourseStatut.AT_RESTAURANT, CourseStatut.COMPLETED, CourseStatut.CANCELLED])(
      'course pas en livraison (%s) : 400',
      async (statutCourse) => {
        const { la, t, annuler } = enTournee({ statutCourse });
        const e = await refus(annuler(la.id));
        expect(e).toBeInstanceOf(BadRequestException);
        expect(e.message).toBe('La course doit être en phase IN_DELIVERY');
        expect(la.statut).toBe(DeliveryStatut.IN_ROUTE);
        expect(t.journalDe('LIVRAISON_ANNULEE')).toHaveLength(0);
      },
    );

    it('livraison déjà remise avec le code : 400, la commande reste terminée', async () => {
      const { d1, a, la, t, annuler, tickets } = enTournee();
      la.statut = DeliveryStatut.ARRIVED;
      await t.actionsLivraison.confirmDelivery(la.id, d1.id, { pin: '4821' } as never);
      expect(a.status).toBe(OrderStatus.COMPLETED);

      const e = await refus(annuler(la.id));
      expect(e).toBeInstanceOf(BadRequestException);
      expect(e.message).toBe('Statut delivery attendu PENDING ou IN_ROUTE ou ARRIVED, actuel DELIVERED');
      expect(a.status).toBe(OrderStatus.COMPLETED);
      expect(tickets.fils).toHaveLength(0);
    });

    it('« Autre » sans note : 400', async () => {
      const { la, annuler } = enTournee();
      const e = await refus(annuler(la.id, { reason: DeliveryFailureReason.OTHER }));
      expect(e).toBeInstanceOf(BadRequestException);
      expect(e.message).toBe('Une note est requise pour le motif OTHER');
      expect(la.statut).toBe(DeliveryStatut.IN_ROUTE);
    });

    it('commande pas encore remise (prête au comptoir) : 409 « Commande pas encore remise. »', async () => {
      const { b, lb, annuler, tickets, t } = enTournee();
      b.status = OrderStatus.READY;
      b.picked_up_at = null;

      const e = await refus(annuler(lb.id));

      expect(e).toBeInstanceOf(ConflictException);
      expect(e.message).toBe('Commande pas encore remise.');
      expect(lb.statut).toBe(DeliveryStatut.PENDING);
      expect(b.status).toBe(OrderStatus.READY);
      expect(tickets.fils).toHaveLength(0);
      expect(t.emisSur(CourseChannels.DELIVERY_STATUT_CHANGED)).toHaveLength(0);
    });

    it('commande rendue au comptoir entre la lecture et l’écriture : l’écriture porte la commande, 409', async () => {
      const { b, lb, t, annuler } = enTournee();
      const lire = t.base.prisma.delivery.findUnique.getMockImplementation()!;
      t.base.prisma.delivery.findUnique.mockImplementation(async (args: any) => {
        const lue = await lire(args);
        if (args?.include?.course) b.status = OrderStatus.READY;
        return lue;
      });

      const e = await refus(annuler(lb.id));

      expect(e).toBeInstanceOf(ConflictException);
      expect(lb.statut).toBe(DeliveryStatut.PENDING);
    });
  });

  it('commande déjà annulée par l’admin pendant la tournée : la livraison passe, la commande n’est pas réécrite', async () => {
    const { a, la, annuler, tickets } = enTournee();
    Object.assign(a, {
      status: OrderStatus.CANCELLED,
      cancelled_at: avant(120),
      cancelled_by: 'admin',
      cancelled_reason: 'Client a rappelé',
    });

    await annuler(la.id);

    expect(la.statut).toBe(DeliveryStatut.FAILED);
    expect(a).toMatchObject({
      status: OrderStatus.CANCELLED,
      cancelled_at: avant(120),
      cancelled_by: 'admin',
      cancelled_reason: 'Client a rappelé',
    });
    expect(tickets.fils).toHaveLength(1);
  });

  it('concurrence : code du client et « Annuler » au même instant, un seul gagne', async () => {
    const { d1, a, la, t, annuler, tickets } = enTournee();
    la.statut = DeliveryStatut.ARRIVED;

    const [confirmee, annulee] = await Promise.allSettled([
      t.actionsLivraison.confirmDelivery(la.id, d1.id, { pin: '4821' } as never),
      annuler(la.id),
    ]);

    const gagnants = [confirmee, annulee].filter((r) => r.status === 'fulfilled');
    expect(gagnants).toHaveLength(1);
    if (la.statut === DeliveryStatut.DELIVERED) {
      expect(a.status).toBe(OrderStatus.COMPLETED);
      expect(tickets.fils).toHaveLength(0);
    } else {
      expect(la.statut).toBe(DeliveryStatut.FAILED);
      commandeIntacte(a, true);
      expect(tickets.fils).toHaveLength(1);
    }
    expect(t.emisSur(CourseChannels.DELIVERY_STATUT_CHANGED)).toHaveLength(1);
  });

  it('aucune catégorie de ticket : l’annulation est faite, pas de ticket', async () => {
    const { a, la, t, annuler, tickets } = enTournee({ categories: [] });

    const rendue = await annuler(la.id);

    expect(rendue).toMatchObject({ statut: DeliveryStatut.FAILED });
    commandeIntacte(a, true);
    expect(tickets.fils).toHaveLength(0);
    expect(t.journalDe('LIVRAISON_ANNULEE')).toHaveLength(1);
  });

  it('un ticket qui échoue n’annule jamais l’annulation', async () => {
    const { la, t, annuler } = enTournee();
    t.base.prisma.ticketThread.create.mockRejectedValue(new Error('base coupée'));

    await expect(annuler(la.id)).resolves.toMatchObject({ statut: DeliveryStatut.FAILED });
    expect(la.statut).toBe(DeliveryStatut.FAILED);
  });

  it('`/fail` (appli déjà installée) : mêmes effets, la commande n’est jamais annulée', async () => {
    const { a, k, la, t, echouer, tickets } = enTournee();

    const rendue = await echouer(la.id);

    expect(rendue).toMatchObject({ id: la.id, statut: DeliveryStatut.FAILED, failure_reason: DeliveryFailureReason.CLIENT_ABSENT });
    commandeIntacte(a, true);
    expect(k.statut).toBe(CourseStatut.IN_DELIVERY);
    expect(t.journalDe('LIVRAISON_ANNULEE')).toEqual([
      expect.objectContaining({ details: { route: 'fail', note: 'Client absent' } }),
    ]);
    expect(tickets.fils).toEqual([expect.objectContaining({ orderId: a.id, priority: 'HIGH' })]);
  });

  describe('planificateur, relance et annulation de la course', () => {
    it('la commande en livraison à livraison en échec n’est jamais reprise par le planificateur', async () => {
      const { a, k, la, t, annuler } = enTournee({ seulementA: true });
      await annuler(la.id);
      expect(k.statut).toBe(CourseStatut.COMPLETED);
      const courses = t.base.courses.length;

      await t.passer();

      expect(t.base.courses).toHaveLength(courses);
      expect(t.journalDe('COURSE_CREEE')).toHaveLength(0);
      expect(t.base.livraisons.filter((l) => l.order_id === a.id)).toHaveLength(1);
      commandeIntacte(a, true);
    });

    it('« Relancer la livraison » garde son refus existant', async () => {
      const { a, k, la, t, annuler } = enTournee({ seulementA: true });
      await annuler(la.id);

      const relance = await t.offres.relancerCourseAnnulee(k.id);

      expect(relance.ok).toBe(false);
      expect(relance.message).toMatch(/^Aucune livraison annulée avec une commande encore active/);
      commandeIntacte(a, true);
    });

    it('l’annulation de la course par l’admin ne touche pas la livraison en échec', async () => {
      const { a, b, k, la, lb, t, annuler } = enTournee();
      await annuler(la.id);
      (t.push as Record<string, unknown>).notifyCourseCancelled = jest.fn();

      await t.actions.cancelCourse(k.id, 'admin', { reason: 'Livreur en panne' } as never);

      expect(la.statut).toBe(DeliveryStatut.FAILED);
      commandeIntacte(a, true);
      // La livraison encore à faire suit la règle existante (annulée, commande remise prête).
      expect(lb.statut).not.toBe(DeliveryStatut.FAILED);
      expect(b.status).toBe(OrderStatus.READY);
    });
  });

  it('noter le client après « Annuler » : acceptée', async () => {
    const { d1, la, service, annuler } = enTournee();
    await annuler(la.id);

    const notee = await service.rateCustomer(la.id, d1.id, { rating: 2, note: 'Absent' } as never);

    expect(notee).toMatchObject({ id: la.id, customer_rating: 2 });
  });
});
