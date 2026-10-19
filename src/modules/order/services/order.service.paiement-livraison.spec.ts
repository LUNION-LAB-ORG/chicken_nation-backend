/**
 * PAIEMENT À LA LIVRAISON SUR LE SITE (19/10) : création par `createv2`.
 *
 * Sur le site (canal WEB), quatre contrôles dans cet ordre : un moyen de
 * paiement connu, l'option ouverte (Paramètres > Commandes), une livraison,
 * et une seule commande à confirmer à la fois par client. La commande créée
 * est un BROUILLON : ni « Nouvelle commande » au restaurant, ni socket vers
 * sa salle, et sa taxe est comptée comme pour un paiement en ligne (le site
 * affiche exactement ce que le serveur facture). L'application n'est pas
 * concernée : elle accepte OFFLINE sans contrôle, comme avant.
 *
 * Méthode testée en isolation, comme order.service.audience.spec.ts : seules
 * les dépendances qu'elle lit sont greffées. La recherche d'une commande à
 * confirmer ÉVALUE le `where` reçu contre les commandes en base.
 */
import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  EntityStatus,
  LoyaltyLevel,
  OrderChannel,
  OrderStatus,
  OrderType,
  PaymentMethod,
} from '@prisma/client';
import { estBrouillon } from '../helpers/brouillons.rules';
import { OrderV2Helper } from '../helpers/orderv2.helper';
import { correspond } from '../relance/relance.base-simulee-spec';
import { OrderService } from './order.service';

const CLIENT = '44444444-4444-4444-8444-444444444444';
const AUTRE_CLIENT = '55555555-5555-4555-8555-555555555555';
const RESTAURANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const client = {
  customer_id: CLIENT,
  loyalty_level: LoyaltyLevel.STANDARD,
  profile_type: null,
  total_points: 0,
  fullname: 'Awa Koné',
  phone: '+2250700000000',
  email: null,
  expo_token: 'ExponentPushToken[client]',
};

type Ligne = Record<string, unknown>;

/** Commande déjà en base (pour le contrôle « une seule à la fois »). */
const enBase = (surcharge: Ligne = {}): Ligne => ({
  reference: 'ORD-261019-11111',
  customer_id: CLIENT,
  created_at: new Date('2026-10-19T09:00:00.000Z'),
  auto: true,
  channel: OrderChannel.WEB,
  payment_method: PaymentMethod.OFFLINE,
  paied: false,
  status: OrderStatus.PENDING,
  entity_status: EntityStatus.ACTIVE,
  ...surcharge,
});

function monter({ reglageActif = true, commandes = [] as Ligne[] } = {}) {
  const tx = {
    order: { create: jest.fn(async ({ data }: { data: Ligne }) => ({ id: 'commande-1', ...data })) },
    reward: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  const greffes = {
    prisma: {
      $transaction: jest.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
      reward: { findMany: jest.fn().mockResolvedValue([]) },
      order: {
        findFirst: jest.fn(async ({ where }: { where: Ligne }) => {
          const trouvee = commandes.find((c) => correspond(c, where));
          return trouvee ? { reference: trouvee.reference } : null;
        }),
      },
    },
    orderHelperV2: {
      paiementLivraisonSiteActif: jest.fn().mockResolvedValue(reglageActif),
      resolveCustomerData: jest.fn().mockResolvedValue(client),
      getDishesWithDetails: jest.fn().mockResolvedValue([{ id: 'plat-1', name: 'Poulet braisé', audiences: [] }]),
      calculateOrderDetails: jest.fn().mockResolvedValue({
        orderItems: [],
        netAmount: 10000,
        totalDishes: 10000,
        totalDishesEtOptions: 10000,
      }),
      applyPromoCode: jest.fn().mockResolvedValue({ discount: 0, type: null }),
      validateAddress: jest.fn().mockResolvedValue({ latitude: 5.35, longitude: -3.98 }),
      findEligibleDeliveryRestaurant: jest.fn().mockResolvedValue({ id: RESTAURANT_A }),
      validateRestaurantChoice: jest.fn().mockResolvedValue({ id: RESTAURANT_A }),
      calculateTax: jest.fn().mockResolvedValue(500),
      generateOrderReference: jest.fn().mockReturnValue('ORD-261019-22222'),
      getOrderStatus: jest.fn().mockReturnValue(OrderStatus.PENDING),
    },
    deliveryFeeHelper: {
      isAppDeliveryDisabled: jest.fn().mockResolvedValue({ disabled: false, message: '' }),
      calculeFraisLivraison: jest.fn().mockResolvedValue({
        montant: 1000,
        original_montant: 1000,
        discount: 0,
        service: 'TURBO',
        zone_id: null,
        distance: 3,
      }),
    },
    orderHelper: { remiseFidelite: jest.fn().mockResolvedValue({ remise: 0, points: 0 }) },
    generateDataService: { generateRecoveryCode: jest.fn().mockReturnValue('1234') },
    orderEvent: { orderCreatedEvent: jest.fn() },
    orderWebSocketService: { emitOrderCreated: jest.fn() },
    signalerAnomalieLivraison: jest.fn().mockResolvedValue(undefined),
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
  };
  const service = Object.create(OrderService.prototype) as OrderService;
  Object.assign(service, greffes);
  return { service, tx, ...greffes };
}

const corps = (surcharge: Ligne = {}) =>
  ({
    items: [{ dish_id: 'plat-1', quantity: 1, epice: false, supplements: [] }],
    type: OrderType.DELIVERY,
    address: JSON.stringify({ title: 'Maison', latitude: 5.35, longitude: -3.98 }),
    payment_method: PaymentMethod.OFFLINE,
    ...surcharge,
  }) as never;

/** Le texte d'un refus, espaces insécables lues comme des espaces. */
async function refus(promesse: Promise<unknown>) {
  try {
    await promesse;
  } catch (e) {
    return { classe: (e as Error).constructor, message: (e as Error).message.replace(/\u00a0/g, ' ') };
  }
  throw new Error('La promesse devait être rejetée');
}

describe('OrderService.createv2 : paiement à la livraison sur le site', () => {
  it('cas nominal : commande à confirmer créée, brouillon, taxe comptée, restaurant tenu à l’écart', async () => {
    const m = monter();

    const commande = await m.service.createv2(CLIENT, corps(), OrderChannel.WEB);

    const donnees = m.tx.order.create.mock.calls[0][0].data;
    expect(donnees).toEqual(
      expect.objectContaining({
        channel: OrderChannel.WEB,
        payment_method: PaymentMethod.OFFLINE,
        auto: true,
        paied: false,
        status: OrderStatus.PENDING,
        tax: 500,
        delivery_fee: 1000,
        // Exactement ce que le site a affiché : articles, frais de service, livraison.
        amount: 11500,
      }),
    );
    expect(estBrouillon(commande)).toBe(true);
    // Ni « Nouvelle commande » au restaurant, ni « Commande confirmée ! » au client.
    expect(m.orderEvent.orderCreatedEvent).toHaveBeenCalledWith(expect.objectContaining({ brouillon: true }));
    // Socket : charge réduite au back office, rien vers la salle du restaurant.
    expect(m.orderWebSocketService.emitOrderCreated).toHaveBeenCalledWith(commande, { brouillon: true });
    // Contrôle « une seule à la fois » sur ce client et cette règle.
    expect(m.prisma.order.findFirst.mock.calls[0][0].where).toEqual(
      expect.objectContaining({
        customer_id: CLIENT,
        auto: true,
        channel: OrderChannel.WEB,
        payment_method: PaymentMethod.OFFLINE,
        paied: false,
        status: OrderStatus.PENDING,
      }),
    );
  });

  it('option coupée dans Paramètres > Commandes : 400, rien créé', async () => {
    const m = monter({ reglageActif: false });

    const erreur = await refus(m.service.createv2(CLIENT, corps(), OrderChannel.WEB));

    expect(erreur).toEqual({
      classe: BadRequestException,
      message: 'Le paiement à la livraison est indisponible pour le moment : payez en ligne.',
    });
    expect(m.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('à emporter ou sur place : 400, le livreur seul encaisse', async () => {
    for (const type of [OrderType.PICKUP, OrderType.TABLE]) {
      const m = monter();
      const erreur = await refus(
        m.service.createv2(CLIENT, corps({ type, restaurant_id: RESTAURANT_A, address: undefined }), OrderChannel.WEB),
      );
      expect({ type, erreur }).toEqual({
        type,
        erreur: {
          classe: BadRequestException,
          message: "Sur le site, le paiement à la livraison n'est proposé que pour une livraison.",
        },
      });
      expect(m.prisma.$transaction).not.toHaveBeenCalled();
    }
  });

  it('une commande à confirmer du même client attend déjà : 409 qui la nomme, rien créé', async () => {
    const m = monter({ commandes: [enBase()] });

    const erreur = await refus(m.service.createv2(CLIENT, corps(), OrderChannel.WEB));

    expect(erreur).toEqual({
      classe: ConflictException,
      message:
        'Vous avez déjà une commande en attente de confirmation (ORD-261019-11111) : notre équipe vous appelle. ' +
        'Pour la changer, ouvrez-la puis « Modifier ma commande ».',
    });
    expect(m.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('ne bloquent pas : la commande d’un autre client, une commande confirmée, annulée par le client, en ligne, ou de l’application', async () => {
    const m = monter({
      commandes: [
        enBase({ customer_id: AUTRE_CLIENT }),
        enBase({ auto: false, status: OrderStatus.ACCEPTED }),
        enBase({ status: OrderStatus.CANCELLED, entity_status: EntityStatus.DELETED, cancelled_by: 'client' }),
        enBase({ payment_method: PaymentMethod.ONLINE }),
        enBase({ channel: OrderChannel.APP }),
        enBase({ channel: null }),
      ],
    });

    await m.service.createv2(CLIENT, corps(), OrderChannel.WEB);

    expect(m.tx.order.create).toHaveBeenCalledTimes(1);
  });

  it('sans moyen de paiement, ou un moyen inconnu : 400', async () => {
    for (const payment_method of [undefined, null, 'ESPECES']) {
      const m = monter();
      const erreur = await refus(m.service.createv2(CLIENT, corps({ payment_method }), OrderChannel.WEB));
      expect({ payment_method, erreur }).toEqual({
        payment_method,
        erreur: { classe: BadRequestException, message: 'Choisissez un moyen de paiement.' },
      });
      expect(m.orderHelperV2.paiementLivraisonSiteActif).not.toHaveBeenCalled();
    }
  });

  it('les contrôles suivent l’ordre de la conception : option coupée avant le retrait, retrait avant le doublon', async () => {
    const coupee = monter({ reglageActif: false, commandes: [enBase()] });
    expect(
      (await refus(coupee.service.createv2(CLIENT, corps({ type: OrderType.PICKUP }), OrderChannel.WEB))).message,
    ).toMatch(/indisponible/);

    const retrait = monter({ commandes: [enBase()] });
    expect(
      (await refus(retrait.service.createv2(CLIENT, corps({ type: OrderType.PICKUP }), OrderChannel.WEB))).message,
    ).toMatch(/que pour une livraison/);
    expect(retrait.prisma.order.findFirst).not.toHaveBeenCalled();
  });

  it('paiement en ligne sur le site : inchangé, aucun contrôle de plus, brouillon comme avant', async () => {
    const m = monter({ reglageActif: false, commandes: [enBase()] });

    const commande = await m.service.createv2(CLIENT, corps({ payment_method: PaymentMethod.ONLINE }), OrderChannel.WEB);

    expect(m.orderHelperV2.paiementLivraisonSiteActif).not.toHaveBeenCalled();
    expect(m.prisma.order.findFirst).not.toHaveBeenCalled();
    expect(estBrouillon(commande)).toBe(true);
    expect(m.orderEvent.orderCreatedEvent).toHaveBeenCalledWith(expect.objectContaining({ brouillon: true }));
  });

  it('application en espèces (canal APP) : acceptée sans contrôle, pas un brouillon, comme avant', async () => {
    const m = monter({ reglageActif: false, commandes: [enBase()] });

    const commande = await m.service.createv2(CLIENT, corps({ type: OrderType.PICKUP, restaurant_id: RESTAURANT_A }));

    expect(m.orderHelperV2.paiementLivraisonSiteActif).not.toHaveBeenCalled();
    expect(m.prisma.order.findFirst).not.toHaveBeenCalled();
    expect(commande).toEqual(expect.objectContaining({ channel: OrderChannel.APP, payment_method: PaymentMethod.OFFLINE }));
    expect(estBrouillon(commande)).toBe(false);
    expect(m.orderEvent.orderCreatedEvent).toHaveBeenCalledWith(expect.objectContaining({ brouillon: false }));
    expect(m.orderWebSocketService.emitOrderCreated).toHaveBeenCalledWith(commande, { brouillon: false });
  });
});

describe('OrderV2Helper.paiementLivraisonSiteActif : lecture du réglage', () => {
  const lire = async (valeur: string | null) => {
    const helper = Object.create(OrderV2Helper.prototype) as OrderV2Helper;
    const settingsService = { get: jest.fn().mockResolvedValue(valeur) };
    Object.assign(helper, { settingsService });
    const actif = await helper.paiementLivraisonSiteActif();
    expect(settingsService.get).toHaveBeenCalledWith('order_paiement_livraison_site');
    return actif;
  };

  it('absent : proposé dès le déploiement (décision du 19/10)', async () => {
    expect(await lire(null)).toBe(true);
  });

  it('« 1 » : proposé ; « 0 » : coupé', async () => {
    expect(await lire('1')).toBe(true);
    expect(await lire('0')).toBe(false);
  });
});
