/**
 * CONTRAT DU PAIEMENT À LA LIVRAISON SUR LE SITE (19/10/2026), FIGÉ.
 *
 * Trois dépôts parlent ce contrat : ce serveur, le backoffice (« À relancer »)
 * et le site (étape Paiement, suivi). Les réponses ci-dessous sont celles que
 * le serveur RÉEL produit, sérialisées comme en HTTP (JSON). Elles sont
 * recopiées À L'IDENTIQUE dans :
 *  - backoffice/features/orders/utils/__tests__/contrat-serveur.test.ts
 *    (`GET /orders/relances`, `POST /orders/relances/:orderId/annuler`) ;
 *  - chicken_nation/features/commande/contrat-serveur.test.ts
 *    (`GET /orders/conditions-commande`, `POST /orders/create-v2`, réglage).
 *
 * Si l'un de ces tests casse, le contrat a changé : changez les trois copies
 * ensemble, et les écrans qui les lisent.
 */
import { ValidationPipe } from '@nestjs/common';
import { EntityStatus, OrderChannel, OrderStatus, PaymentMethod } from '@prisma/client';
import { OrderController } from './controllers/order.controller';
import { AnnulerRelanceDto } from './dto/annuler-relance.dto';
import { OrderV2Helper } from './helpers/orderv2.helper';
import { REFUS_PAIEMENT_SITE, REGLAGE_PAIEMENT_LIVRAISON_SITE } from './helpers/paiement-livraison.rules';
import { AWA, RESTO_A, commande, monterRelance } from './relance/relance.base-simulee-spec';
import { OrderService } from './services/order.service';

/** Ce que reçoit le client HTTP : dates en ISO, `undefined` retirés. */
const enJson = <T>(valeur: T): unknown => JSON.parse(JSON.stringify(valeur));

// ===========================================================================
// GET /orders/conditions-commande (lu par le site)
// ===========================================================================

describe('contrat : GET /orders/conditions-commande', () => {
  /**
   * Service réel, réglages lus par le vrai `OrderV2Helper`. `reglage` :
   * l'ancien réglage du site, seul enregistré tant que personne n'a repris
   * Paramètres > Commandes ; `autres` : les réglages du 26/11.
   */
  const monter = (reglage: string | null, autres: Record<string, string> = {}) => {
    const helper = Object.create(OrderV2Helper.prototype) as OrderV2Helper;
    const valeurs = { ...(reglage === null ? {} : { [REGLAGE_PAIEMENT_LIVRAISON_SITE]: reglage }), ...autres };
    const settingsService = { getMany: jest.fn().mockResolvedValue(valeurs) };
    Object.assign(helper, { settingsService, getTaxRate: jest.fn().mockResolvedValue(0.05) });
    const service = Object.create(OrderService.prototype) as OrderService;
    Object.assign(service, {
      orderHelperV2: helper,
      deliveryFeeHelper: {
        load: jest.fn().mockResolvedValue({
          grid: [
            { maxKm: 2, price: 1000 },
            { maxKm: null, price: 2000 },
          ],
          turboZonesEnabled: false,
        }),
        isAppDeliveryDisabled: jest.fn().mockResolvedValue({ disabled: false, message: '' }),
      },
    });
    return { service, settingsService };
  };

  it('réglage absent : paiement à la livraison PROPOSÉ (décision du 19/10), forme exacte', async () => {
    const { service, settingsService } = monter(null);
    const surPlace = {
      actif: false,
      paiement: 'EN_LIGNE',
      message: "La commande sur place n'est pas proposée pour le moment. Choisissez un autre mode de réception.",
    };

    expect(enJson(await service.obtenirConditionsCommande())).toEqual({
      taux_frais_service: 0.05,
      grille_frais: [
        { distance_max_km: 2, montant: 1000 },
        { distance_max_km: null, montant: 2000 },
      ],
      grille_frais_appliquee: true,
      paiement_livraison: { disponible: true },
      // Paramétrage du SITE (26/11), rien de réglé : ce qu'il faisait déjà.
      // La livraison se paie en ligne ou à la livraison, et la commande à
      // payer à la réception attend la confirmation du centre d'appels.
      types: {
        DELIVERY: { actif: true, paiement: 'LES_DEUX', message: null },
        PICKUP: { actif: true, paiement: 'EN_LIGNE', message: null },
        TABLE: surPlace,
      },
      reception: 'APRES_CONFIRMATION',
      // Paramétrage de L'APPLICATION, rien de réglé : paiement en ligne, et
      // la commande à payer à la réception part directement au restaurant.
      appli: {
        types: {
          DELIVERY: { actif: true, paiement: 'EN_LIGNE', message: null },
          PICKUP: { actif: true, paiement: 'EN_LIGNE', message: null },
          TABLE: surPlace,
        },
        reception: 'DIRECTE',
      },
    });
    expect(settingsService.getMany).toHaveBeenCalledWith(expect.arrayContaining(['order_paiement_livraison_site']));
    expect(REGLAGE_PAIEMENT_LIVRAISON_SITE).toBe('order_paiement_livraison_site');
  });

  it('réglage à « 0 » (choix « Non » du backoffice) : option retirée ; « 1 » : proposée', async () => {
    expect(enJson((await monter('0').service.obtenirConditionsCommande()).paiement_livraison)).toEqual({
      disponible: false,
    });
    expect(enJson((await monter('1').service.obtenirConditionsCommande()).paiement_livraison)).toEqual({
      disponible: true,
    });
  });

  it('paiement d’une livraison sur le site : la même clé qu’avant, avec les trois choix du 26/11', async () => {
    const lire = async (valeur: string) => (await monter(valeur).service.obtenirConditionsCommande());
    // « Les deux » et « à la réception seulement » : le paiement à la livraison est proposé.
    expect((await lire('LES_DEUX')).paiement_livraison).toEqual({ disponible: true });
    const seule = await lire('A_LA_RECEPTION');
    expect(seule.paiement_livraison).toEqual({ disponible: true });
    expect(seule.types.DELIVERY.paiement).toBe('A_LA_RECEPTION');
    // « En ligne seulement » : retiré.
    expect((await lire('EN_LIGNE')).paiement_livraison).toEqual({ disponible: false });
    // Elle ne règle que le site : l'application garde son paiement.
    expect(seule.appli.types.DELIVERY.paiement).toBe('EN_LIGNE');
  });

  it('un paramétrage par canal (26/11) : `types` et `reception` pour le site, `appli` pour l’application', async () => {
    const lu = await monter(null, {
      // Application : pas de livraison, sur place proposé, à emporter payé au choix, après confirmation.
      order_type_livraison_appli: '0',
      order_type_sur_place_appli: '1',
      order_paiement_emporter_appli: 'LES_DEUX',
      order_paiement_reception_appli: 'APRES_CONFIRMATION',
      // Site : pas d'à emporter, commande directe.
      order_type_emporter_site: '0',
      order_paiement_reception_site: 'DIRECTE',
    }).service.obtenirConditionsCommande();
    expect([lu.types.DELIVERY.actif, lu.appli.types.DELIVERY.actif]).toEqual([true, false]);
    expect([lu.types.PICKUP.actif, lu.appli.types.PICKUP.actif]).toEqual([false, true]);
    expect([lu.types.TABLE.actif, lu.appli.types.TABLE.actif]).toEqual([false, true]);
    expect([lu.types.PICKUP.paiement, lu.appli.types.PICKUP.paiement]).toEqual(['EN_LIGNE', 'LES_DEUX']);
    expect([lu.reception, lu.appli.reception]).toEqual(['DIRECTE', 'APRES_CONFIRMATION']);
  });
});

// ===========================================================================
// POST /orders/create-v2 (site) : refus affichés tels quels par le site
// ===========================================================================

describe('contrat : POST /orders/create-v2 sur le site', () => {
  /** Contrôleur réel, service et KKiaPay factices. */
  const monter = () => {
    const orderService = { createv2: jest.fn().mockResolvedValue({ id: 'o1', restaurant_id: RESTO_A }) };
    const kkiapayService = { getPublicPaymentConfig: jest.fn().mockResolvedValue(null) };
    const controleur = new OrderController(
      kkiapayService as never,
      orderService as never,
      null as never,
      null as never,
      null as never,
    );
    return { controleur, orderService };
  };
  // Corps envoyé par le site (creerCommandeAction), après le tuyau de validation.
  const corps = { type: 'DELIVERY', payment_method: 'OFFLINE', items: [] } as never;

  it('en-tête `x-canal-commande: web` : canal WEB ; sans lui : APP (application)', async () => {
    const site = monter();
    await site.controleur.createorderv2(
      { user: { id: 'client-1' }, headers: { 'x-canal-commande': 'web' } } as never,
      corps,
    );
    expect(site.orderService.createv2).toHaveBeenCalledWith(
      'client-1',
      expect.objectContaining({ type: 'DELIVERY', payment_method: 'OFFLINE' }),
      OrderChannel.WEB,
      { compatiblePaystack: false },
    );

    const appli = monter();
    await appli.controleur.createorderv2({ user: { id: 'client-1' }, headers: {} } as never, corps);
    expect(appli.orderService.createv2).toHaveBeenCalledWith('client-1', expect.anything(), OrderChannel.APP, { compatiblePaystack: false });
  });

  it('refus : textes exacts (champ `message` de l’erreur), affichés tels quels par le site', () => {
    expect(REFUS_PAIEMENT_SITE.moyenAbsent).toBe('Choisissez un moyen de paiement.');
    expect(REFUS_PAIEMENT_SITE.indisponible).toBe(
      'Le paiement à la livraison est indisponible pour le moment : payez en ligne.',
    );
    expect(REFUS_PAIEMENT_SITE.dejaEnAttente('ORD-261019-00002')).toBe(
      'Vous avez déjà une commande en attente de confirmation (ORD-261019-00002) : notre équipe vous appelle. ' +
        'Pour la changer, ouvrez-la puis « Modifier ma commande ».',
    );
  });
});

// ===========================================================================
// GET /orders/relances (lu par le backoffice)
// ===========================================================================

/** Instant de la lecture : tout le reste s'en déduit. */
const T = new Date('2026-10-19T12:00:00.000Z');

/**
 * Trois clients :
 *  - Awa : un panier de l'application non payé (1 min, le client le paie
 *    peut-être encore), puis une commande du site à payer à la livraison
 *    (30 s) : un groupe, tête = la commande à confirmer, signal « paiement en
 *    ligne en cours » jusqu'à la fin du délai (1 min 30) ;
 *  - Yao : une commande à confirmer de 4 h (hors fenêtre, toujours listée),
 *    puis une commande confirmée il y a 30 min : doublon possible ;
 *  - Blé : un panier de l'application seul (8 min) : inchangé.
 */
const SCENARIO = () => [
  commande(T, 1, {
    id: 'a0000000-0000-4000-8000-000000000001',
    reference: 'ORD-261019-00001',
    customer_id: 'c0000000-0000-4000-8000-0000000000a1',
    fullname: 'Awa Koné',
    phone: '0700000001',
    amount: 5050,
    channel: 'APP',
  }),
  commande(T, 0.5, {
    id: 'a0000000-0000-4000-8000-000000000002',
    reference: 'ORD-261019-00002',
    customer_id: 'c0000000-0000-4000-8000-0000000000a1',
    fullname: 'Awa Koné',
    phone: '0700000001',
    amount: 7600,
    channel: 'WEB',
    payment_method: PaymentMethod.OFFLINE,
  }),
  commande(T, 4 * 60, {
    id: 'a0000000-0000-4000-8000-000000000003',
    reference: 'ORD-261019-00003',
    customer_id: 'c0000000-0000-4000-8000-0000000000b2',
    fullname: 'Yao Kouassi',
    phone: '0700000002',
    amount: 9100,
    channel: 'WEB',
    payment_method: PaymentMethod.OFFLINE,
  }),
  commande(T, 30, {
    id: 'a0000000-0000-4000-8000-000000000004',
    reference: 'ORD-261019-00004',
    customer_id: 'c0000000-0000-4000-8000-0000000000b2',
    fullname: 'Yao Kouassi',
    phone: '0700000002',
    amount: 9100,
    channel: 'WEB',
    payment_method: PaymentMethod.OFFLINE,
    auto: false,
    status: OrderStatus.ACCEPTED,
  }),
  commande(T, 8, {
    id: 'a0000000-0000-4000-8000-000000000005',
    reference: 'ORD-261019-00005',
    customer_id: 'c0000000-0000-4000-8000-0000000000c3',
    fullname: 'Blé Gnahoré',
    phone: '0700000003',
    amount: 3500,
    channel: 'APP',
    entity_status: EntityStatus.ACTIVE,
  }),
];

/** Ligne de la liste, telle que le serveur la renvoie. */
const ligne = (
  id: string,
  reference: string,
  created_at: string,
  client_nom: string,
  telephone: string,
  amount: number,
  channel: string,
  paiement_a_la_livraison: boolean,
) => ({
  id,
  reference,
  created_at,
  client_nom,
  telephone,
  restaurant: { id: RESTO_A, name: 'Riviera' },
  type: 'DELIVERY',
  amount,
  paiement_refuse: false,
  annulee_par_client: false,
  channel,
  paiement_a_la_livraison,
});

const SIGNAUX_VIDES = {
  paiement_refuse: false,
  paiement_partiel: null,
  commande_recente: null,
  annulee_par_client: null,
  commande_suivante: null,
  paiement_en_ligne_en_cours: null,
  // Paiement KKiaPay signalé par le webhook sans confirmation (14/11).
  paiement_signale: null,
};

/**
 * LA réponse figée. Copie exacte : backoffice,
 * features/orders/utils/__tests__/contrat-serveur.test.ts (`REPONSE_RELANCES`).
 */
const REPONSE_RELANCES = {
  maintenant: '2026-10-19T12:00:00.000Z',
  regles: { delai_minutes: 1.5, fenetre_heures: 3, duree_prise_minutes: 10, rappel_minutes: 5 },
  prochaine_echeance: '2026-10-19T12:00:30.000Z',
  compteurs: { a_relancer: 3, pris: 0, pris_par_moi: 0, en_cours: 0, ignorees: 0, a_confirmer: 2 },
  groupes: [
    {
      cle: 'a0000000-0000-4000-8000-000000000003',
      etat: 'A_RELANCER',
      a_confirmer: true,
      tete: ligne(
        'a0000000-0000-4000-8000-000000000003',
        'ORD-261019-00003',
        '2026-10-19T08:00:00.000Z',
        'Yao Kouassi',
        '0700000002',
        9100,
        'WEB',
        true,
      ),
      autres: [],
      alerte_le: null,
      prise: null,
      signaux: {
        ...SIGNAUX_VIDES,
        commande_suivante: { reference: 'ORD-261019-00004', created_at: '2026-10-19T11:30:00.000Z' },
      },
      crm: null,
    },
    {
      cle: 'a0000000-0000-4000-8000-000000000002',
      etat: 'A_RELANCER',
      a_confirmer: true,
      tete: ligne(
        'a0000000-0000-4000-8000-000000000002',
        'ORD-261019-00002',
        '2026-10-19T11:59:30.000Z',
        'Awa Koné',
        '0700000001',
        7600,
        'WEB',
        true,
      ),
      autres: [
        ligne(
          'a0000000-0000-4000-8000-000000000001',
          'ORD-261019-00001',
          '2026-10-19T11:59:00.000Z',
          'Awa Koné',
          '0700000001',
          5050,
          'APP',
          false,
        ),
      ],
      alerte_le: null,
      prise: null,
      signaux: {
        ...SIGNAUX_VIDES,
        paiement_en_ligne_en_cours: { reference: 'ORD-261019-00001', jusqua: '2026-10-19T12:00:30.000Z' },
      },
      crm: null,
    },
    {
      cle: 'a0000000-0000-4000-8000-000000000005',
      etat: 'A_RELANCER',
      a_confirmer: false,
      tete: ligne(
        'a0000000-0000-4000-8000-000000000005',
        'ORD-261019-00005',
        '2026-10-19T11:52:00.000Z',
        'Blé Gnahoré',
        '0700000003',
        3500,
        'APP',
        false,
      ),
      autres: [],
      alerte_le: null,
      prise: null,
      signaux: SIGNAUX_VIDES,
      crm: null,
    },
  ],
};

describe('contrat : GET /orders/relances', () => {
  beforeEach(() => {
    // Seule l'horloge est figée : promesses et minuteries restent réelles.
    jest.useFakeTimers({
      now: T,
      doNotFake: [
        'hrtime',
        'nextTick',
        'performance',
        'queueMicrotask',
        'requestAnimationFrame',
        'cancelAnimationFrame',
        'requestIdleCallback',
        'cancelIdleCallback',
        'setImmediate',
        'clearImmediate',
        'setInterval',
        'clearInterval',
        'setTimeout',
        'clearTimeout',
      ],
    });
  });
  afterEach(() => jest.useRealTimers());

  it('forme exacte : commandes à confirmer en tête, pastille, doublon possible, paiement en ligne en cours, compteur', async () => {
    const { service } = monterRelance({ commandes: SCENARIO() });

    expect(enJson(await service.lister(AWA))).toEqual(REPONSE_RELANCES);
  });
});

// ===========================================================================
// POST /orders/relances/:orderId/annuler (envoyé par le backoffice)
// ===========================================================================

describe('contrat : corps de POST /orders/relances/:orderId/annuler', () => {
  // Mêmes options que le tuyau global (main.ts).
  const pipe = new ValidationPipe({ whitelist: true, transform: true });
  const lire = (corps: unknown) => pipe.transform(corps, { type: 'body', metatype: AnnulerRelanceDto });

  it('le corps du backoffice (schéma `ignorerRelanceSchema`) passe tel quel', async () => {
    // Raison de la liste : le texte n'est pas envoyé. « Autre » : avec son texte.
    await expect(lire({ raison_code: 'CLIENT_INJOIGNABLE' })).resolves.toEqual(
      expect.objectContaining({ raison_code: 'CLIENT_INJOIGNABLE' }),
    );
    await expect(lire({ raison_code: 'AUTRE', raison_texte: 'Adresse hors zone' })).resolves.toEqual(
      expect.objectContaining({ raison_code: 'AUTRE', raison_texte: 'Adresse hors zone' }),
    );
  });

  it('raison inconnue : 400 « Choisissez une raison. »', async () => {
    await expect(lire({ raison_code: 'IGNORE' })).rejects.toMatchObject({
      response: expect.objectContaining({ message: ['Choisissez une raison.'] }),
    });
  });
});
