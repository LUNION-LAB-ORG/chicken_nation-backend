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
  /** Service réel, réglage du paiement à la livraison lu par le vrai `OrderV2Helper`. */
  const monter = (reglage: string | null) => {
    const helper = Object.create(OrderV2Helper.prototype) as OrderV2Helper;
    const settingsService = { get: jest.fn().mockResolvedValue(reglage) };
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
      },
    });
    return { service, settingsService };
  };

  it('réglage absent : paiement à la livraison PROPOSÉ (décision du 19/10), forme exacte', async () => {
    const { service, settingsService } = monter(null);

    expect(enJson(await service.obtenirConditionsCommande())).toEqual({
      taux_frais_service: 0.05,
      grille_frais: [
        { distance_max_km: 2, montant: 1000 },
        { distance_max_km: null, montant: 2000 },
      ],
      grille_frais_appliquee: true,
      paiement_livraison: { disponible: true },
    });
    expect(settingsService.get).toHaveBeenCalledWith('order_paiement_livraison_site');
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
    );

    const appli = monter();
    await appli.controleur.createorderv2({ user: { id: 'client-1' }, headers: {} } as never, corps);
    expect(appli.orderService.createv2).toHaveBeenCalledWith('client-1', expect.anything(), OrderChannel.APP);
  });

  it('refus : textes exacts (champ `message` de l’erreur), affichés tels quels par le site', () => {
    expect(REFUS_PAIEMENT_SITE.moyenAbsent).toBe('Choisissez un moyen de paiement.');
    expect(REFUS_PAIEMENT_SITE.indisponible).toBe(
      'Le paiement à la livraison est indisponible pour le moment : payez en ligne.',
    );
    expect(REFUS_PAIEMENT_SITE.livraisonSeulement).toBe(
      "Sur le site, le paiement à la livraison n'est proposé que pour une livraison.",
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
 *  - Awa : un panier de l'application non payé (2 min, le client le paie
 *    peut-être encore), puis une commande du site à payer à la livraison
 *    (1 min) : un groupe, tête = la commande à confirmer, signal « paiement en
 *    ligne en cours » jusqu'à la fin du délai ;
 *  - Yao : une commande à confirmer de 4 h (hors fenêtre, toujours listée),
 *    puis une commande confirmée il y a 30 min : doublon possible ;
 *  - Blé : un panier de l'application seul (8 min) : inchangé.
 */
const SCENARIO = () => [
  commande(T, 2, {
    id: 'a0000000-0000-4000-8000-000000000001',
    reference: 'ORD-261019-00001',
    customer_id: 'c0000000-0000-4000-8000-0000000000a1',
    fullname: 'Awa Koné',
    phone: '0700000001',
    amount: 5050,
    channel: 'APP',
  }),
  commande(T, 1, {
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
};

/**
 * LA réponse figée. Copie exacte : backoffice,
 * features/orders/utils/__tests__/contrat-serveur.test.ts (`REPONSE_RELANCES`).
 */
const REPONSE_RELANCES = {
  maintenant: '2026-10-19T12:00:00.000Z',
  regles: { delai_minutes: 3, fenetre_heures: 3, duree_prise_minutes: 10, rappel_minutes: 5 },
  prochaine_echeance: '2026-10-19T12:01:00.000Z',
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
        '2026-10-19T11:59:00.000Z',
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
          '2026-10-19T11:58:00.000Z',
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
        paiement_en_ligne_en_cours: { reference: 'ORD-261019-00001', jusqua: '2026-10-19T12:01:00.000Z' },
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
