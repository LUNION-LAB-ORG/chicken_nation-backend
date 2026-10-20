import { OrderStatus, OrderType, PaymentMethod } from '@prisma/client';
import {
  CommandeNotifiee,
  getOrderNotificationContent,
  messageAccepteeRestaurant,
  presenceConfirmee,
} from './order-notifications.constante';

/**
 * Cloche « commande acceptée » du restaurant. Recette du 20/10 : la reprise
 * au téléphone d'une commande du site À LIVRER disait « Le client a confirmé
 * sa présence. Lancez la cuisson », texte du seul client de l'application qui
 * arrive au restaurant.
 */

const commande = (surcharge: Partial<CommandeNotifiee> = {}): CommandeNotifiee => ({
  reference: 'ORD-261020-52033',
  status: OrderStatus.ACCEPTED,
  amount: 10100,
  restaurant_name: 'CHICKEN NATION ZONE 4',
  customer_name: 'Koffi Essai',
  payment_method: PaymentMethod.OFFLINE,
  order_type: OrderType.DELIVERY,
  auto: false,
  ...surcharge,
});

describe('Cloche du restaurant, commande acceptée', () => {
  it('livraison reprise au téléphone (site, à payer à la livraison) : à livrer, jamais « présence »', () => {
    const { message } = getOrderNotificationContent(commande(), 'restaurant');
    expect(message).toBe('Commande à livrer #ORD-261020-52033 (Koffi Essai) confirmée. Lancez la cuisson !');
    expect(message).not.toMatch(/présence/);
  });

  it('livraison, quels que soient le paiement et la saisie : jamais « présence »', () => {
    for (const payment_method of [PaymentMethod.OFFLINE, PaymentMethod.ONLINE]) {
      for (const auto of [true, false, null, undefined]) {
        const c = commande({ payment_method, auto });
        expect(presenceConfirmee(c)).toBe(false);
        expect(messageAccepteeRestaurant(c)).toMatch(/^Commande à livrer #ORD-261020-52033 /);
      }
    }
  });

  it('application, à emporter ou sur place, à payer au restaurant : le client a confirmé sa présence', () => {
    for (const order_type of [OrderType.PICKUP, OrderType.TABLE]) {
      const { message } = getOrderNotificationContent(commande({ order_type, auto: true }), 'restaurant');
      expect(message).toBe('Le client Koffi Essai a confirmé sa présence. Lancez la cuisson pour la commande #ORD-261020-52033 !');
    }
  });

  it('à emporter payée en ligne, ou saisie par le personnel : confirmée, sans « présence »', () => {
    expect(messageAccepteeRestaurant(commande({ order_type: OrderType.PICKUP, payment_method: PaymentMethod.ONLINE, auto: true }))).toBe(
      'Commande à emporter #ORD-261020-52033 (Koffi Essai) confirmée. Lancez la cuisson !',
    );
    expect(messageAccepteeRestaurant(commande({ order_type: OrderType.TABLE, auto: false }))).toBe(
      'Commande sur place #ORD-261020-52033 (Koffi Essai) confirmée. Lancez la cuisson !',
    );
  });

  it('type ou saisie inconnus : message neutre, jamais « présence »', () => {
    const c = commande({ order_type: undefined, auto: undefined });
    expect(messageAccepteeRestaurant(c)).toBe('Commande #ORD-261020-52033 (Koffi Essai) confirmée. Lancez la cuisson !');
    expect(messageAccepteeRestaurant(commande({ order_type: OrderType.PICKUP, auto: undefined }))).not.toMatch(/présence/);
  });

  it('texte du client : « présence » seulement dans le même cas', () => {
    expect(getOrderNotificationContent(commande(), 'customer').message).toBe(
      "C'est parti ! Votre commande #ORD-261020-52033 est confirmée. CHICKEN NATION ZONE 4 commence la cuisson.",
    );
    expect(getOrderNotificationContent(commande({ order_type: OrderType.PICKUP, auto: true }), 'customer').message).toMatch(
      /Votre présence est confirmée/,
    );
  });

  it('aucun tiret cadratin dans les textes', () => {
    for (const status of Object.values(OrderStatus)) {
      for (const cible of ['customer', 'restaurant'] as const) {
        const { title, message } = getOrderNotificationContent(commande({ status }), cible);
        expect(`${title} ${message}`).not.toMatch(/—/);
      }
    }
  });
});
