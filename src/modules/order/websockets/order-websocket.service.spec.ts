/**
 * Aucune commande ne part sur un socket avec de quoi écrire au téléphone du
 * client : le serveur pousse sans jeton d'accès Expo, un jeton divulgué suffit
 * donc à envoyer n'importe quel message au nom de Chicken Nation. Les salles du
 * restaurant (caisse, cuisine, livreurs) et du back office reçoivent chaque
 * commande.
 */

import { EntityStatus, Order, OrderStatus, PaymentMethod } from '@prisma/client';
import { OrderChannels } from '../enums/order-channels';
import { CLES_IDENTIFIANTS_PUSH } from '../helpers/identifiants-push.helper';
import { OrderWebSocketService } from './order-websocket.service';

const commande = () =>
  ({
    id: 'o1',
    reference: 'CMD-1',
    customer_id: 'c1',
    restaurant_id: 'r1',
    status: OrderStatus.READY,
    recovery_code: '4821',
    customer: {
      id: 'c1',
      first_name: 'Awa',
      phone: '+2250700000000',
      notification_settings: {
        expo_push_token: 'ExponentPushToken[abc]',
        expo_push_token_revoked: 'ExponentPushToken[old]',
        onesignal_id: 'os-1',
        onesignal_subscription_id: 'os-sub-1',
      },
    },
  }) as unknown as Order;

function monter() {
  const appGateway = {
    emitToUser: jest.fn(),
    emitToBackoffice: jest.fn(),
    emitToRestaurant: jest.fn(),
  };
  const service = new OrderWebSocketService(appGateway as never);
  /** Charge utile de chaque émission, quel que soit le destinataire. */
  const charges = () => [
    ...appGateway.emitToUser.mock.calls.map((c) => ({ salle: 'client', canal: c[2], charge: c[3] })),
    ...appGateway.emitToBackoffice.mock.calls.map((c) => ({ salle: 'backoffice', canal: c[0], charge: c[1] })),
    ...appGateway.emitToRestaurant.mock.calls.map((c) => ({ salle: 'restaurant', canal: c[1], charge: c[2] })),
  ];
  return { service, charges };
}

function toutesLesCles(valeur: unknown, cles = new Set<string>()): Set<string> {
  if (Array.isArray(valeur)) {
    valeur.forEach((v) => toutesLesCles(v, cles));
  } else if (valeur && typeof valeur === 'object' && !(valeur instanceof Date)) {
    for (const [cle, contenu] of Object.entries(valeur)) {
      cles.add(cle);
      toutesLesCles(contenu, cles);
    }
  }
  return cles;
}

describe('OrderWebSocketService', () => {
  const cas: [string, (s: OrderWebSocketService, o: Order) => void, OrderChannels][] = [
    ['création', (s, o) => s.emitOrderCreated(o), OrderChannels.ORDER_CREATED],
    ['changement de statut', (s, o) => s.emitStatusUpdate(o, OrderStatus.IN_PROGRESS), OrderChannels.ORDER_STATUS_UPDATED],
    ['modification', (s, o) => s.emitOrderUpdated(o), OrderChannels.ORDER_UPDATED],
  ];

  it.each(cas)('%s : aucun identifiant de notification, dans aucune salle', (_nom, emettre, canal) => {
    const { service, charges } = monter();
    emettre(service, commande());

    const emissions = charges();
    expect(emissions).toHaveLength(3);
    for (const { canal: recu, charge } of emissions) {
      expect(recu).toBe(canal);
      const cles = toutesLesCles(charge);
      for (const interdite of CLES_IDENTIFIANTS_PUSH) expect(cles.has(interdite)).toBe(false);
    }
  });

  it.each(cas)('%s : le client garde son code et ce qu’il lit, les diffusions perdent le code', (_nom, emettre) => {
    const { service, charges } = monter();
    emettre(service, commande());

    for (const { salle, charge } of charges()) {
      expect(charge.order.customer).toEqual({ id: 'c1', first_name: 'Awa', phone: '+2250700000000' });
      expect(charge.order.recovery_code).toBe(salle === 'client' ? '4821' : undefined);
    }
  });

  it("ne modifie pas la commande reçue : l'appelant y lit encore le jeton pour sa notification", () => {
    const { service } = monter();
    const original = commande() as unknown as { customer: { notification_settings: { expo_push_token: string } } };
    service.emitStatusUpdate(original as unknown as Order, OrderStatus.IN_PROGRESS);
    expect(original.customer.notification_settings.expo_push_token).toBe('ExponentPushToken[abc]');
  });
});

/**
 * Les restaurants ne voient pas les paniers non payés de l'application
 * (décision 4 de la relance des commandes en attente). Le back office n'en
 * reçoit qu'une charge réduite : `backoffice_all` réunit aussi le marketing et
 * la comptabilité.
 */
describe('OrderWebSocketService : brouillons', () => {
  const brouillon = (surcharge: Record<string, unknown> = {}) =>
    ({
      ...(commande() as unknown as Record<string, unknown>),
      status: OrderStatus.PENDING,
      auto: true,
      paied: false,
      payment_method: PaymentMethod.ONLINE,
      entity_status: EntityStatus.ACTIVE,
      created_at: new Date('2026-10-01T10:00:00.000Z'),
      fullname: 'Anne Marie Aka',
      phone: '+2250700000000',
      address: { title: 'Maison', latitude: 5.3, longitude: -4 },
      ...surcharge,
    }) as unknown as Order;

  const CHARGE_REDUITE = ['id', 'status', 'auto', 'restaurant_id', 'created_at'];

  function verifierReduite(emissions: { salle: string; charge: any }[]) {
    const restaurant = emissions.filter((e) => e.salle === 'restaurant');
    expect(restaurant).toEqual([]);
    const backoffice = emissions.filter((e) => e.salle === 'backoffice');
    expect(backoffice).toHaveLength(1);
    expect(Object.keys(backoffice[0].charge.order).sort()).toEqual([...CHARGE_REDUITE].sort());
    for (const interdite of ['fullname', 'phone', 'address', 'customer', 'email', 'recovery_code']) {
      expect(toutesLesCles(backoffice[0].charge).has(interdite)).toBe(false);
    }
    // Le client garde sa commande entière.
    const client = emissions.filter((e) => e.salle === 'client');
    expect(client).toHaveLength(1);
    expect(client[0].charge.order.fullname).toBe('Anne Marie Aka');
  }

  it('création d’un brouillon : rien au restaurant, charge réduite au back office', () => {
    const { service, charges } = monter();
    service.emitOrderCreated(brouillon(), { brouillon: true });
    verifierReduite(charges());
  });

  it('création non marquée (appel du paiement, commande encore lue « en attente ») : inchangée', () => {
    const { service, charges } = monter();
    service.emitOrderCreated(brouillon());
    const emissions = charges();
    expect(emissions.map((e) => e.salle).sort()).toEqual(['backoffice', 'client', 'restaurant']);
    expect(emissions.find((e) => e.salle === 'restaurant')!.charge.order.fullname).toBe('Anne Marie Aka');
  });

  it('commande du personnel : inchangée', () => {
    const { service, charges } = monter();
    service.emitOrderCreated(brouillon({ auto: false, status: OrderStatus.ACCEPTED }), { brouillon: false });
    expect(charges().map((e) => e.salle).sort()).toEqual(['backoffice', 'client', 'restaurant']);
  });

  it('panier annulé par le client : jugé sur l’état précédent, rien au restaurant', () => {
    const { service, charges } = monter();
    service.emitStatusUpdate(brouillon({ status: OrderStatus.CANCELLED }), OrderStatus.PENDING);
    const emissions = charges();
    verifierReduite(emissions);
    const backoffice = emissions.find((e) => e.salle === 'backoffice')!;
    expect(backoffice.charge.previousStatus).toBe(OrderStatus.PENDING);
    expect(backoffice.charge.message).toBe('Commande annulée');
  });

  it('panier annulé par le client, désormais supprimé (01/10) : toujours rien au restaurant', () => {
    const { service, charges } = monter();
    service.emitStatusUpdate(
      brouillon({ status: OrderStatus.CANCELLED, entity_status: EntityStatus.DELETED, cancelled_by: 'client' }),
      OrderStatus.PENDING,
    );
    verifierReduite(charges());
  });

  it('panier annulé par le client retouché par le centre d’appels : rien au restaurant, charge réduite', () => {
    const { service, charges } = monter();
    service.emitOrderUpdated(
      brouillon({ status: OrderStatus.CANCELLED, entity_status: EntityStatus.DELETED, cancelled_by: 'client' }),
    );
    verifierReduite(charges());
  });

  it('panier payé (paied) : le restaurant reçoit le changement de statut', () => {
    const { service, charges } = monter();
    service.emitStatusUpdate(brouillon({ status: OrderStatus.ACCEPTED, paied: true }), OrderStatus.PENDING);
    expect(charges().map((e) => e.salle).sort()).toEqual(['backoffice', 'client', 'restaurant']);
  });

  it('panier repris au téléphone (auto à faux) : le restaurant reçoit le changement de statut', () => {
    const { service, charges } = monter();
    service.emitStatusUpdate(
      brouillon({ status: OrderStatus.ACCEPTED, auto: false, payment_method: PaymentMethod.OFFLINE }),
      OrderStatus.PENDING,
    );
    expect(charges().map((e) => e.salle).sort()).toEqual(['backoffice', 'client', 'restaurant']);
  });

  it('panier accepté par le personnel sans bascule : devient une commande à préparer, le restaurant la reçoit', () => {
    const { service, charges } = monter();
    service.emitStatusUpdate(brouillon({ status: OrderStatus.ACCEPTED }), OrderStatus.PENDING);
    expect(charges().map((e) => e.salle).sort()).toEqual(['backoffice', 'client', 'restaurant']);
  });

  it('modification d’un panier non payé (adresse changée) : rien au restaurant, charge réduite', () => {
    const { service, charges } = monter();
    service.emitOrderUpdated(brouillon());
    verifierReduite(charges());
  });

  it('modification d’un panier payé : inchangée', () => {
    const { service, charges } = monter();
    service.emitOrderUpdated(brouillon({ paied: true }));
    expect(charges().map((e) => e.salle).sort()).toEqual(['backoffice', 'client', 'restaurant']);
  });

  it('suppression : seul l’identifiant part, dans chaque salle', () => {
    const appGateway = { emitToUser: jest.fn(), emitToBackoffice: jest.fn(), emitToRestaurant: jest.fn() };
    const service = new OrderWebSocketService(appGateway as never);
    service.emitOrderDeleted(brouillon());
    const charges = [
      appGateway.emitToUser.mock.calls[0][3],
      appGateway.emitToBackoffice.mock.calls[0][1],
      appGateway.emitToRestaurant.mock.calls[0][2],
    ];
    for (const charge of charges) expect(charge).toEqual({ orderId: 'o1', message: 'Commande supprimée' });
  });
});
