/**
 * Tickets du livreur (feuille « Problème », 27/10).
 *
 * « Terminer » crée SEULEMENT un ticket, par la route existante
 * `POST /tickets/deliverer/me`, avec en plus la commande (`orderId`). Le
 * serveur vérifie que la commande est dans une course du livreur, enregistre
 * le lien et renvoie la commande : le ticket n'est plus « sans commande » et
 * le restaurant le reçoit. Livraison, course et commande ne bougent pas.
 *
 * « Annuler » : le serveur crée le ticket lui-même (`LivraisonAnnuleeListener`),
 * par le même service, catégorie choisie par son nom.
 */
import { ForbiddenException } from '@nestjs/common';
import { CourseStatut, DeliveryFailureReason, DeliveryStatut, EntityStatus, OrderStatus } from '@prisma/client';

import { commande, course, livraison, livreur, monterBaseDispatch } from 'src/modules/course/services/base-dispatch.simulee-spec';

import { TicketEvent } from '../events/ticket.event';
import { LivraisonAnnuleeListener } from '../listeners/livraison-annulee.listener';
import { SupportWebSocketService } from '../websockets/support-websocket.service';
import { brancherTickets, CATEGORIE_LIVRAISON, CATEGORIE_PAIEMENT } from './base-tickets.simulee-spec';
import { CategoriesTicketService } from './categories-ticket.service';
import { DelivererTicketsService } from './deliverer-tickets.service';

function monter(categories?: Record<string, unknown>[]) {
  const a = livreur({ first_name: 'Koffi', last_name: 'Yao', phone: '+2250700000001' });
  const b = livreur({ first_name: 'Awa', last_name: 'Koné' });
  const k = course({ statut: CourseStatut.IN_DELIVERY, deliverer_id: a.id, parti_at: new Date() });
  const autre = course({ statut: CourseStatut.IN_DELIVERY, deliverer_id: b.id });
  const o = commande({ status: OrderStatus.PICKED_UP, paied: true });
  const oB = commande({ status: OrderStatus.PICKED_UP });
  const l = livraison({ course_id: k.id, order_id: o.id, statut: DeliveryStatut.ARRIVED });
  const lB = livraison({ course_id: autre.id, order_id: oB.id, statut: DeliveryStatut.IN_ROUTE });
  const base = monterBaseDispatch({ livreurs: [a, b], courses: [k, autre], commandes: [o, oB], livraisons: [l, lB] });
  const tickets = brancherTickets(base.prisma, { commandes: base.commandes, livreurs: base.livreurs }, categories);
  const bus = { emit: jest.fn() };
  const service = new DelivererTicketsService(
    base.prisma,
    new TicketEvent(bus as never),
    new CategoriesTicketService(base.prisma),
    {} as never,
  );
  const crees = () => bus.emit.mock.calls.filter(([canal]) => canal === 'ticket.created').map(([, charge]) => charge);
  const instantane = () => JSON.stringify({ courses: base.courses, livraisons: base.livraisons, commandes: base.commandes });
  return { a, b, k, o, oB, l, base, tickets, service, crees, instantane };
}

const corps = (surcharge: Record<string, unknown> = {}) => ({
  subject: 'Client absent, commande CMD-1',
  initialMessage: 'Client absent\nCommande CMD-1 · Course CRS-1',
  categoryId: CATEGORIE_LIVRAISON.id,
  priority: 'HIGH' as const,
  ...surcharge,
});

describe('« Terminer » : ticket avec la commande (POST /tickets/deliverer/me)', () => {
  it('commande d’une de ses courses : lien enregistré, commande renvoyée, le restaurant reçoit le ticket', async () => {
    const { a, k, o, service, tickets, crees, instantane } = monter();
    const avant = instantane();

    const ticket = await service.createTicket(a.id, corps({ courseId: k.id, orderId: o.id }) as never);

    expect(tickets.fils).toEqual([
      expect.objectContaining({ orderId: o.id, delivererId: a.id, priority: 'HIGH', source: 'mobile_deliverer' }),
    ]);
    expect(ticket.order).toEqual(
      expect.objectContaining({ id: o.id, reference: o.reference, restaurantId: o.restaurant_id }),
    );
    expect(ticket.deliverer).toEqual(expect.objectContaining({ id: a.id, name: 'Koffi Yao', phone: '+2250700000001' }));
    expect(tickets.messages).toEqual([
      expect.objectContaining({ body: 'Client absent\nCommande CMD-1 · Course CRS-1', authorDelivererId: a.id }),
    ]);

    // L'événement de création part au restaurant de la commande.
    expect(crees()).toHaveLength(1);
    const passerelle = { emitToBackoffice: jest.fn(), emitToUser: jest.fn(), emitToRestaurant: jest.fn() };
    new SupportWebSocketService(passerelle as never).emitNewTicket(crees()[0] as never);
    expect(passerelle.emitToRestaurant).toHaveBeenCalledWith(o.restaurant_id, 'new:ticket', expect.anything());

    // Ticket seulement : la livraison continue.
    expect(instantane()).toBe(avant);
  });

  it('commande d’un autre livreur : 403 « Commande hors de tes courses. », rien n’est créé', async () => {
    const { a, oB, service, tickets, crees, instantane } = monter();
    const avant = instantane();

    const refus = service.createTicket(a.id, corps({ orderId: oB.id }) as never);

    await expect(refus).rejects.toBeInstanceOf(ForbiddenException);
    await expect(refus).rejects.toThrow('Commande hors de tes courses.');
    expect(tickets.fils).toHaveLength(0);
    expect(crees()).toHaveLength(0);
    expect(instantane()).toBe(avant);
  });

  it('commande inconnue : 403 aussi (rien n’est révélé)', async () => {
    const { a, service, tickets } = monter();
    await expect(
      service.createTicket(a.id, corps({ orderId: '00000000-0000-4000-8000-000000000000' }) as never),
    ).rejects.toThrow('Commande hors de tes courses.');
    expect(tickets.fils).toHaveLength(0);
  });

  it('sans commande : comme avant (ticket sans commande)', async () => {
    const { a, k, service, tickets, instantane } = monter();
    const avant = instantane();

    const ticket = await service.createTicket(a.id, corps({ courseId: k.id }) as never);

    expect(tickets.fils).toEqual([expect.objectContaining({ delivererId: a.id })]);
    expect(tickets.fils[0].orderId).toBeUndefined();
    expect(ticket.order).toBeNull();
    expect(instantane()).toBe(avant);
  });

  it('code déjà pris au même instant (P2002) : le serveur réessaie', async () => {
    const { a, o, service, tickets } = monter();
    tickets.collisions(3);

    await service.createTicket(a.id, corps({ orderId: o.id }) as never);

    expect(tickets.fils).toHaveLength(1);
  });

  it('code toujours pris après 3 nouveaux essais : l’erreur remonte', async () => {
    const { a, o, service, tickets } = monter();
    tickets.collisions(4);

    await expect(service.createTicket(a.id, corps({ orderId: o.id }) as never)).rejects.toMatchObject({ code: 'P2002' });
    expect(tickets.fils).toHaveLength(0);
  });
});

describe('« Annuler » : ticket créé par le serveur', () => {
  const charge = (t: ReturnType<typeof monter>, surcharge: Record<string, unknown> = {}) => ({
    delivery_id: t.l.id,
    order_id: t.o.id,
    order_reference: t.o.reference,
    course_id: t.k.id,
    course_reference: t.k.reference,
    restaurant_id: t.k.restaurant_id,
    deliverer_id: t.a.id,
    reason: DeliveryFailureReason.CLIENT_ABSENT,
    note: 'Client absent',
    route: 'annuler' as const,
    ...surcharge,
  });

  it('sujet, message, commande liée, priorité haute, au nom du livreur', async () => {
    const t = monter();
    await new LivraisonAnnuleeListener(t.service).creerTicket(charge(t));

    expect(t.tickets.fils).toEqual([
      expect.objectContaining({
        subject: 'Livraison annulée : Client absent',
        priority: 'HIGH',
        source: 'mobile_deliverer',
        delivererId: t.a.id,
        orderId: t.o.id,
        categoryId: CATEGORIE_LIVRAISON.id,
      }),
    ]);
    expect(t.tickets.messages[0].body).toBe(`Client absent\nCommande ${t.o.reference} · Course ${t.k.reference}`);
    expect(t.crees()).toEqual([expect.objectContaining({ order: expect.objectContaining({ reference: t.o.reference }) })]);
  });

  it('sans note : le motif court', async () => {
    const t = monter();
    await new LivraisonAnnuleeListener(t.service).creerTicket(
      charge(t, { reason: DeliveryFailureReason.ADDRESS_NOT_FOUND, note: null }),
    );
    expect(t.tickets.fils[0].subject).toBe('Livraison annulée : Adresse introuvable');
    expect(t.tickets.messages[0].body).toBe(`Adresse introuvable\nCommande ${t.o.reference} · Course ${t.k.reference}`);
  });

  it.each([
    ['« livraison » d’abord', [CATEGORIE_PAIEMENT, { id: 'c-course', name: 'Course', entity_status: EntityStatus.ACTIVE }, CATEGORIE_LIVRAISON], CATEGORIE_LIVRAISON.id],
    ['puis « course »', [CATEGORIE_PAIEMENT, { id: 'c-course', name: 'Suivi de course', entity_status: EntityStatus.ACTIVE }], 'c-course'],
    ['sinon la première active', [{ id: 'c-z', name: 'Zone', entity_status: EntityStatus.ACTIVE }, CATEGORIE_PAIEMENT], CATEGORIE_PAIEMENT.id],
    ['une catégorie inactive ne compte pas', [{ id: 'c-off', name: 'Livraisons (ancienne)', entity_status: EntityStatus.INACTIVE }, CATEGORIE_PAIEMENT], CATEGORIE_PAIEMENT.id],
  ])('catégorie par son nom : %s', async (_cas, categories, attendue) => {
    const t = monter(categories as Record<string, unknown>[]);
    await new LivraisonAnnuleeListener(t.service).creerTicket(charge(t));
    expect(t.tickets.fils[0].categoryId).toBe(attendue);
  });

  it('aucune catégorie : pas de ticket, pas d’erreur', async () => {
    const t = monter([]);
    await expect(new LivraisonAnnuleeListener(t.service).creerTicket(charge(t))).resolves.toBeUndefined();
    expect(t.tickets.fils).toHaveLength(0);
  });

  it('un échec de la base n’est jamais remonté', async () => {
    const t = monter();
    t.base.prisma.ticketThread.create.mockRejectedValue(new Error('base coupée'));
    await expect(new LivraisonAnnuleeListener(t.service).creerTicket(charge(t))).resolves.toBeUndefined();
  });
});
