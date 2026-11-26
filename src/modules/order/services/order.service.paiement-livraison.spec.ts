/**
 * COMMANDE À PAYER À LA RÉCEPTION, création par `createv2` (site le 19/10,
 * application et site sous le même réglage le 26/11).
 *
 * Sur le site (canal WEB) comme dans l'application (canal APP) : un moyen de
 * paiement connu (site), un type proposé, un moyen permis pour ce type, puis
 * le parcours réglé au back-office. « Après confirmation » : la commande est
 * un BROUILLON à confirmer, ni « Nouvelle commande » au restaurant, ni socket
 * vers sa salle, une seule à la fois par client. « Directe » : elle part au
 * restaurant, acceptée dès la création. Sa taxe est comptée comme pour un
 * paiement en ligne (on affiche exactement ce que le serveur facture).
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
import type { ModeReception, ReglagesCommande } from '../helpers/reglages-commande.rules';
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
  a_confirmer: false,
  payment_method: PaymentMethod.OFFLINE,
  paied: false,
  status: OrderStatus.PENDING,
  entity_status: EntityStatus.ACTIVE,
  ...surcharge,
});

/** Tout proposé, en ligne ou à la réception : ces tests règlent ce qu'ils regardent. */
const TOUT_PERMIS: ReglagesCommande = {
  DELIVERY: { actif: true, paiement: 'LES_DEUX', message: null },
  PICKUP: { actif: true, paiement: 'LES_DEUX', message: null },
  TABLE: { actif: true, paiement: 'LES_DEUX', message: null },
};

function monter({
  types = {} as Partial<ReglagesCommande>,
  reception = 'APRES_CONFIRMATION' as ModeReception,
  commandes = [] as Ligne[],
} = {}) {
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
      // Types, paiement et parcours (26/11), application et site.
      reglagesCommande: jest.fn().mockResolvedValue({ types: { ...TOUT_PERMIS, ...types }, reception }),
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

const EN_LIGNE_SEULEMENT = { actif: true, paiement: 'EN_LIGNE' as const, message: null };
const aEmporter = (payment_method: PaymentMethod) =>
  corps({ type: OrderType.PICKUP, restaurant_id: RESTAURANT_A, address: undefined, payment_method });

describe('OrderService.createv2 : à payer à la réception, APRÈS CONFIRMATION (réglage par défaut)', () => {
  it('site : commande à confirmer créée, brouillon, taxe comptée, restaurant tenu à l’écart', async () => {
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
        // Le repère est posé : la commande attend l'appel du centre d'appels.
        a_confirmer: true,
        tax: 500,
        delivery_fee: 1000,
        // Exactement ce que le site a affiché : articles, frais de service, livraison.
        amount: 11500,
      }),
    );
    expect(donnees.accepted_at).toBeUndefined();
    expect(estBrouillon(commande)).toBe(true);
    // Ni « Nouvelle commande » au restaurant, ni « Commande confirmée ! » au client.
    expect(m.orderEvent.orderCreatedEvent).toHaveBeenCalledWith(expect.objectContaining({ brouillon: true }));
    // Socket : charge réduite au back office, rien vers la salle du restaurant.
    expect(m.orderWebSocketService.emitOrderCreated).toHaveBeenCalledWith(commande, { brouillon: true });
    // Contrôle « une seule à la fois » sur ce client et cette règle.
    expect(m.prisma.order.findFirst.mock.calls[0][0].where).toEqual({ customer_id: CLIENT, ...A_CONFIRMER_WHERE });
  });

  it('application : même parcours, la commande porte le repère et attend le centre d’appels', async () => {
    const m = monter();

    const commande = await m.service.createv2(CLIENT, corps(), OrderChannel.APP);

    expect(m.tx.order.create.mock.calls[0][0].data).toEqual(
      expect.objectContaining({
        channel: OrderChannel.APP,
        payment_method: PaymentMethod.OFFLINE,
        status: OrderStatus.PENDING,
        a_confirmer: true,
        auto: true,
        paied: false,
      }),
    );
    // Un brouillon, comme celle du site : le restaurant ne la voit pas encore.
    expect(estBrouillon(commande)).toBe(true);
    expect(m.orderEvent.orderCreatedEvent).toHaveBeenCalledWith(expect.objectContaining({ brouillon: true }));
    expect(m.orderWebSocketService.emitOrderCreated).toHaveBeenCalledWith(commande, { brouillon: true });
  });

  it('à emporter ou sur place à payer au restaurant, quand le réglage le permet : à confirmer aussi', async () => {
    for (const type of [OrderType.PICKUP, OrderType.TABLE]) {
      for (const canal of [OrderChannel.WEB, OrderChannel.APP]) {
        const m = monter();
        const commande = await m.service.createv2(
          CLIENT,
          corps({ type, restaurant_id: RESTAURANT_A, address: undefined }),
          canal,
        );
        expect({ type, canal, donnees: m.tx.order.create.mock.calls[0][0].data }).toEqual({
          type,
          canal,
          donnees: expect.objectContaining({ status: OrderStatus.PENDING, a_confirmer: true, channel: canal }),
        });
        expect(estBrouillon(commande)).toBe(true);
      }
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

  it('application : même limite, sans renvoyer à « Modifier ma commande » ; une commande de l’appli avec le repère bloque aussi', async () => {
    const enAttenteAppli = enBase({ channel: OrderChannel.APP, a_confirmer: true, reference: 'ORD-261126-33333' });
    const m = monter({ commandes: [enAttenteAppli] });

    const erreur = await refus(m.service.createv2(CLIENT, corps(), OrderChannel.APP));

    expect(erreur).toEqual({
      classe: ConflictException,
      message: 'Vous avez déjà une commande en attente de confirmation (ORD-261126-33333) : notre équipe vous appelle.',
    });
    expect(m.prisma.$transaction).not.toHaveBeenCalled();
    // La limite vaut d'un canal à l'autre : le site refuse aussi.
    const site = monter({ commandes: [enAttenteAppli] });
    expect((await refus(site.service.createv2(CLIENT, corps(), OrderChannel.WEB))).classe).toBe(ConflictException);
  });

  it('ne bloquent pas : la commande d’un autre client, une commande confirmée, annulée par le client, en ligne, ou une ancienne commande en espèces de l’application (sans repère)', async () => {
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
});

describe('OrderService.createv2 : à payer à la réception, DIRECTE', () => {
  it('application : la commande va directement au restaurant, acceptée dès la création', async () => {
    const m = monter({ reception: 'DIRECTE', commandes: [enBase()] });

    const commande = await m.service.createv2(CLIENT, aEmporter(PaymentMethod.OFFLINE));

    expect(commande).toEqual(
      expect.objectContaining({
        channel: OrderChannel.APP,
        payment_method: PaymentMethod.OFFLINE,
        status: OrderStatus.ACCEPTED,
        a_confirmer: false,
        paied: false,
      }),
    );
    expect((commande as { accepted_at?: Date | null }).accepted_at).toBeInstanceOf(Date);
    // Pas une commande à confirmer : le restaurant la reçoit, sans appel du centre d'appels,
    // et la limite « une seule à la fois » ne joue pas.
    expect(m.prisma.order.findFirst).not.toHaveBeenCalled();
    expect(estBrouillon(commande)).toBe(false);
    expect(m.orderEvent.orderCreatedEvent).toHaveBeenCalledWith(expect.objectContaining({ brouillon: false }));
    expect(m.orderWebSocketService.emitOrderCreated).toHaveBeenCalledWith(commande, { brouillon: false });
  });

  it('site : même parcours, la commande n’attend plus le centre d’appels', async () => {
    const m = monter({ reception: 'DIRECTE', commandes: [enBase()] });

    const commande = await m.service.createv2(CLIENT, corps(), OrderChannel.WEB);

    expect(commande).toEqual(
      expect.objectContaining({
        channel: OrderChannel.WEB,
        payment_method: PaymentMethod.OFFLINE,
        status: OrderStatus.ACCEPTED,
        a_confirmer: false,
      }),
    );
    expect((commande as { accepted_at?: Date | null }).accepted_at).toBeInstanceOf(Date);
    expect(estBrouillon(commande)).toBe(false);
    expect(m.prisma.order.findFirst).not.toHaveBeenCalled();
    expect(m.orderEvent.orderCreatedEvent).toHaveBeenCalledWith(expect.objectContaining({ brouillon: false }));
  });
});

describe('OrderService.createv2 : types et paiement réglés au back-office, application et site', () => {
  it('site sans moyen de paiement, ou un moyen inconnu : 400, avant toute lecture des réglages', async () => {
    for (const payment_method of [undefined, null, 'ESPECES']) {
      const m = monter();
      const erreur = await refus(m.service.createv2(CLIENT, corps({ payment_method }), OrderChannel.WEB));
      expect({ payment_method, erreur }).toEqual({
        payment_method,
        erreur: { classe: BadRequestException, message: 'Choisissez un moyen de paiement.' },
      });
      expect(m.orderHelperV2.reglagesCommande).not.toHaveBeenCalled();
    }
  });

  it('livraison à payer en ligne seulement : le site garde son message, rien créé', async () => {
    const m = monter({ types: { DELIVERY: EN_LIGNE_SEULEMENT } });

    const erreur = await refus(m.service.createv2(CLIENT, corps(), OrderChannel.WEB));

    expect(erreur).toEqual({
      classe: BadRequestException,
      message: 'Le paiement à la livraison est indisponible pour le moment : payez en ligne.',
    });
    expect(m.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('en ligne seulement : à la réception refusé, pour le site comme pour l’application', async () => {
    for (const canal of [OrderChannel.WEB, OrderChannel.APP]) {
      const m = monter({ types: { PICKUP: EN_LIGNE_SEULEMENT } });
      const rejet = await refus(m.service.createv2(CLIENT, aEmporter(PaymentMethod.OFFLINE), canal));
      expect({ canal, rejet }).toEqual({
        canal,
        rejet: { classe: BadRequestException, message: 'Pour ce mode de réception, le paiement se fait en ligne.' },
      });
      expect(m.tx.order.create).not.toHaveBeenCalled();
    }
  });

  it('à la réception seulement : en ligne refusé', async () => {
    const reglage = { PICKUP: { actif: true, paiement: 'A_LA_RECEPTION' as const, message: null } };
    const appli = monter({ types: reglage });
    const rejet = await refus(appli.service.createv2(CLIENT, aEmporter(PaymentMethod.ONLINE)));
    expect(rejet.classe).toBe(BadRequestException);
    expect(rejet.message).toContain('le paiement se fait au restaurant');
    expect(rejet.message).toContain("Mettez l'application à jour");
    expect(appli.tx.order.create).not.toHaveBeenCalled();

    const site = monter({ types: reglage });
    const rejetSite = await refus(site.service.createv2(CLIENT, aEmporter(PaymentMethod.ONLINE), OrderChannel.WEB));
    expect(rejetSite.message).toBe('Pour ce mode de réception, le paiement se fait au restaurant.');
  });

  it('type non proposé : refus avec son message, pour le site comme pour l’application', async () => {
    for (const canal of [OrderChannel.WEB, OrderChannel.APP]) {
      const m = monter({
        types: { PICKUP: { actif: false, paiement: 'EN_LIGNE', message: 'La commande à emporter n’est pas proposée.' } },
      });
      const rejet = await refus(m.service.createv2(CLIENT, aEmporter(PaymentMethod.ONLINE), canal));
      expect({ canal, rejet }).toEqual({
        canal,
        rejet: { classe: BadRequestException, message: 'La commande à emporter n’est pas proposée.' },
      });
    }
  });

  it('le type se contrôle avant le doublon : un type non proposé ne lit pas les commandes en attente', async () => {
    const m = monter({
      types: { DELIVERY: { actif: false, paiement: 'LES_DEUX', message: 'La livraison n’est pas proposée.' } },
      commandes: [enBase()],
    });
    expect((await refus(m.service.createv2(CLIENT, corps(), OrderChannel.WEB))).message).toBe(
      'La livraison n’est pas proposée.',
    );
    expect(m.prisma.order.findFirst).not.toHaveBeenCalled();
  });

  it('paiement en ligne : la commande attend son paiement comme avant, sans limite ni repère', async () => {
    for (const canal of [OrderChannel.WEB, OrderChannel.APP]) {
      const m = monter({ commandes: [enBase()] });

      const commande = await m.service.createv2(CLIENT, corps({ payment_method: PaymentMethod.ONLINE }), canal);

      expect(m.prisma.order.findFirst).not.toHaveBeenCalled();
      expect(commande).toEqual(
        expect.objectContaining({ status: OrderStatus.PENDING, payment_method: PaymentMethod.ONLINE, a_confirmer: false }),
      );
      expect(estBrouillon(commande)).toBe(true);
      expect(m.orderEvent.orderCreatedEvent).toHaveBeenCalledWith(expect.objectContaining({ brouillon: true }));
    }
  });
});

describe('OrderV2Helper.reglagesCommande : lecture des réglages', () => {
  const lire = async (valeurs: Record<string, string | null>) => {
    const helper = Object.create(OrderV2Helper.prototype) as OrderV2Helper;
    const settingsService = { getMany: jest.fn().mockResolvedValue(valeurs) };
    Object.assign(helper, { settingsService });
    const lu = await helper.reglagesCommande();
    expect(settingsService.getMany.mock.calls[0][0]).toEqual(
      expect.arrayContaining(['order_paiement_reception', 'order_paiement_livraison', 'order_paiement_livraison_site']),
    );
    return lu;
  };

  it('rien de réglé : après confirmation, et la livraison se paie en ligne ou à la livraison (ancien réglage du site, proposé par défaut)', async () => {
    const lu = await lire({});
    expect(lu.reception).toBe('APRES_CONFIRMATION');
    expect(lu.types.DELIVERY).toEqual({ actif: true, paiement: 'LES_DEUX', message: null });
    expect(lu.types.PICKUP.paiement).toBe('EN_LIGNE');
  });

  it('« directe » enregistré, ancien réglage du site coupé', async () => {
    const lu = await lire({ order_paiement_reception: 'DIRECTE', order_paiement_livraison_site: '0' });
    expect(lu.reception).toBe('DIRECTE');
    expect(lu.types.DELIVERY.paiement).toBe('EN_LIGNE');
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
