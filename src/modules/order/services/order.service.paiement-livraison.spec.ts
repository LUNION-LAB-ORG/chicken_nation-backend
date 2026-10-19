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
 *
 * En fin de fichier : l'annulation par le centre d'appels depuis « À
 * relancer » (`updateStatus` avec `conditionEcriture`), écriture évaluée de
 * même contre la ligne en base.
 */
import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  EntityStatus,
  LoyaltyLevel,
  OrderChannel,
  OrderStatus,
  OrderType,
  PaymentMethod,
  Prisma,
  UserRole,
} from '@prisma/client';
import { estBrouillon } from '../helpers/brouillons.rules';
import { OrderV2Helper } from '../helpers/orderv2.helper';
import { A_CONFIRMER_WHERE } from '../helpers/paiement-livraison.rules';
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

// ===========================================================================
// Annulation depuis « À relancer » : écriture conditionnée (19/10)
// ===========================================================================

describe('OrderService.updateStatus : annulation conditionnée à « à confirmer » (conditionEcriture)', () => {
  const ID = '11111111-1111-4111-8111-111111111111';
  const AGENT = { userId: 'agent-awa', role: UserRole.CALL_CENTER, reason: 'Client injoignable' };

  /** Commande du site à payer à la livraison, telle que `createv2` l'écrit. */
  const aConfirmer: Ligne = {
    id: ID,
    reference: 'ORD-261019-11111',
    type: OrderType.DELIVERY,
    customer_id: CLIENT,
    restaurant_id: RESTAURANT_A,
    auto: true,
    channel: OrderChannel.WEB,
    payment_method: PaymentMethod.OFFLINE,
    paied: false,
    status: OrderStatus.PENDING,
    entity_status: EntityStatus.ACTIVE,
    cancelled_by: null,
    cancelled_reason: null,
    paiements: [],
  };

  /** `entreTemps` : ce qui change en base entre la lecture du début et l'écriture. */
  function monterStatut(commande: Ligne, entreTemps?: (enBase: Ligne) => Ligne) {
    let enBase: Ligne = { ...commande };
    const prisma = {
      order: {
        updateMany: jest.fn(),
        update: jest.fn(async ({ where, data }: { where: Ligne; data: Ligne }) => {
          if (entreTemps) {
            enBase = entreTemps(enBase);
            entreTemps = undefined;
          }
          if (!correspond(enBase, where)) {
            throw new Prisma.PrismaClientKnownRequestError('Record to update not found.', {
              code: 'P2025',
              clientVersion: 'test',
            });
          }
          enBase = { ...enBase, ...data };
          return { ...enBase };
        }),
      },
      notificationSetting: { findUnique: jest.fn().mockResolvedValue(null) },
    };
    const greffes = {
      prisma,
      findById: jest.fn().mockResolvedValue(commande),
      orderHelper: {
        validateStatusTransition: jest.fn(),
        assertPreparationAutorisee: jest.fn(),
        handleStatusSpecificActions: jest.fn().mockResolvedValue(undefined),
        calculateEstimatedTime: jest.fn().mockReturnValue(null),
      },
      promoCodeService: { activateUsageForOrder: jest.fn().mockResolvedValue(undefined) },
      orderCoupon: { restituerPourCommande: jest.fn().mockResolvedValue({ bons: [], codesPromo: [] }) },
      orderEvent: { orderStatusUpdatedEvent: jest.fn() },
      orderWebSocketService: { emitStatusUpdate: jest.fn() },
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    };
    const service = Object.create(OrderService.prototype) as OrderService;
    Object.assign(service, greffes);
    return { service, ...greffes, base: () => enBase };
  }

  it('encore à confirmer : annulée par l’agent, reste active, coupon rendu, aucun son au restaurant', async () => {
    const m = monterStatut(aConfirmer);

    await m.service.updateStatus(ID, OrderStatus.CANCELLED, AGENT, { conditionEcriture: A_CONFIRMER_WHERE });

    expect(m.prisma.order.updateMany).not.toHaveBeenCalled();
    expect(m.prisma.order.update.mock.calls[0][0].where).toEqual({ id: ID, AND: [A_CONFIRMER_WHERE] });
    expect(m.base()).toEqual(
      expect.objectContaining({
        status: OrderStatus.CANCELLED,
        entity_status: EntityStatus.ACTIVE,
        cancelled_by: 'agent-awa',
        cancelled_reason: 'Client injoignable',
      }),
    );
    expect(m.orderCoupon.restituerPourCommande).toHaveBeenCalledWith(expect.objectContaining({ id: ID }), {
      motif: 'ANNULATION',
      acteurId: 'agent-awa',
      acteurRole: UserRole.CALL_CENTER,
    });
    // Le restaurant ne l'a jamais vue : pas de cloche (`etait_brouillon`).
    expect(m.orderEvent.orderStatusUpdatedEvent).toHaveBeenCalledWith(expect.objectContaining({ etait_brouillon: true }));
  });

  it.each([
    ['un collègue la reprend au téléphone', (c: Ligne) => ({ ...c, auto: false, status: OrderStatus.ACCEPTED })],
    [
      'le client l’annule (« Modifier ma commande »)',
      (c: Ligne) => ({ ...c, status: OrderStatus.CANCELLED, entity_status: EntityStatus.DELETED, cancelled_by: 'client' }),
    ],
  ])('%s entre la lecture et l’écriture : 409 « vient de changer », rien écrit ni rendu', async (_cas, changement) => {
    const m = monterStatut(aConfirmer, changement);
    const avant = changement({ ...aConfirmer });

    expect(
      await refus(m.service.updateStatus(ID, OrderStatus.CANCELLED, AGENT, { conditionEcriture: A_CONFIRMER_WHERE })),
    ).toEqual({ classe: ConflictException, message: 'Cette commande vient de changer : actualisez la liste.' });
    expect(m.base()).toEqual(avant);
    expect(m.orderCoupon.restituerPourCommande).not.toHaveBeenCalled();
    expect(m.orderEvent.orderStatusUpdatedEvent).not.toHaveBeenCalled();
    expect(m.orderWebSocketService.emitStatusUpdate).not.toHaveBeenCalled();
  });

  it('sans l’option : écriture et erreurs inchangées', async () => {
    const m = monterStatut(aConfirmer);
    await m.service.updateStatus(ID, OrderStatus.CANCELLED, AGENT);
    expect(m.prisma.order.update.mock.calls[0][0].where).toEqual({ id: ID });

    // Une écriture introuvable remonte telle quelle, comme avant.
    const n = monterStatut(aConfirmer);
    const introuvable = new Prisma.PrismaClientKnownRequestError('Record to update not found.', {
      code: 'P2025',
      clientVersion: 'test',
    });
    n.prisma.order.update.mockRejectedValueOnce(introuvable);
    await expect(n.service.updateStatus(ID, OrderStatus.CANCELLED, AGENT)).rejects.toBe(introuvable);
  });
});
