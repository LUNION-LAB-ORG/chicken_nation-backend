/**
 * Aucune commande ne part sur un socket avec de quoi écrire au téléphone du
 * client : le serveur pousse sans jeton d'accès Expo, un jeton divulgué suffit
 * donc à envoyer n'importe quel message au nom de Chicken Nation. Les salles du
 * restaurant (caisse, cuisine, livreurs) et du back office reçoivent chaque
 * commande.
 */

import { Order, OrderStatus } from '@prisma/client';
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
