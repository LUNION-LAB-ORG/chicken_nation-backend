import { OrderType } from '@prisma/client';
import {
  CatalogueDuJour,
  CommandeLue,
  HABITUDES_PLATS_MAX,
  LigneCommandeLue,
  cleExclusion,
  etablirHabitudes,
  lireOptions,
  lireSupplements,
} from './habitudes-client.rules';

/** Habitudes d'un client à la prise de commande : plats habituels et dernière commande. */

const NOMS: Record<string, string> = {
  burger: 'Burger Patron',
  frites: 'Frites et boisson',
  poulet: 'Poulet braisé',
  campus: 'Menu Campus',
};

const ligne = (dishId: string, surcharge: Partial<LigneCommandeLue> = {}): LigneCommandeLue => ({
  dish_id: dishId,
  quantity: 1,
  amount: 4000,
  epice: false,
  supplements: [],
  options: [],
  dish: { name: NOMS[dishId] ?? dishId, image: null },
  ...surcharge,
});

/** `jour` : plus il est grand, plus la commande est récente. */
const commande = (jour: number, lignes: LigneCommandeLue[], surcharge: Partial<CommandeLue> = {}): CommandeLue => ({
  id: `o${jour}`,
  reference: `ORD-${jour}`,
  created_at: new Date(2026, 10, jour, 12, 0),
  type: OrderType.DELIVERY,
  amount: 7500,
  restaurant: { id: 'r1', name: 'CHICKEN NATION ANGRÉ' },
  order_items: lignes,
  ...surcharge,
});

/** Le service remet les commandes de la plus récente à la plus ancienne. */
const recentesDabord = (...commandes: CommandeLue[]) =>
  [...commandes].sort((a, b) => b.created_at.getTime() - a.created_at.getTime());

const catalogue = (surcharge: Partial<CatalogueDuJour> = {}): CatalogueDuJour => ({
  plats: new Set(Object.keys(NOMS)),
  supplements: new Set(['sauce', 'coca']),
  exclusions: new Set(),
  ...surcharge,
});

describe('habitudes du client : plats habituels', () => {
  it('un plat devient une habitude à partir de deux commandes', () => {
    const h = etablirHabitudes(
      recentesDabord(
        commande(1, [ligne('burger'), ligne('frites')]),
        commande(2, [ligne('burger'), ligne('poulet')]),
        commande(3, [ligne('burger')]),
      ),
      catalogue(),
    );
    expect(h.commandes).toBe(3);
    expect(h.plats.map((p) => [p.dish_id, p.fois])).toEqual([['burger', 3]]);
    expect(h.plats[0].nom).toBe('Burger Patron');
    expect(h.plats[0].derniere_le).toEqual(new Date(2026, 10, 3, 12, 0));
  });

  it('un plat compte une fois par commande, quelle que soit la quantité', () => {
    const h = etablirHabitudes(
      recentesDabord(
        commande(1, [ligne('burger', { quantity: 6 }), ligne('burger', { epice: true })]),
        commande(2, [ligne('frites')]),
      ),
      catalogue(),
    );
    expect(h.plats).toEqual([]);
  });

  it('les plus commandés d’abord, puis le plus récent', () => {
    const h = etablirHabitudes(
      recentesDabord(
        commande(1, [ligne('frites'), ligne('poulet')]),
        commande(2, [ligne('frites'), ligne('burger')]),
        commande(3, [ligne('poulet'), ligne('burger')]),
        commande(4, [ligne('burger')]),
      ),
      catalogue(),
    );
    // burger 3 fois ; poulet et frites 2 fois, poulet commandé plus récemment.
    expect(h.plats.map((p) => p.dish_id)).toEqual(['burger', 'poulet', 'frites']);
  });

  it(`pas plus de ${HABITUDES_PLATS_MAX} plats`, () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const lignes = ids.map((id) => ligne(id));
    const h = etablirHabitudes(
      recentesDabord(commande(1, lignes), commande(2, lignes)),
      catalogue({ plats: new Set(ids) }),
    );
    expect(h.plats).toHaveLength(HABITUDES_PLATS_MAX);
  });

  it('la dernière façon de le commander : épicé, suppléments et choix de la commande la plus récente', () => {
    const h = etablirHabitudes(
      recentesDabord(
        commande(1, [ligne('burger', { epice: false, supplements: [{ id: 'coca', quantity: 1 }] })]),
        commande(2, [
          ligne('burger', {
            epice: true,
            supplements: [{ id: 'sauce', name: 'Sauce piquante', price: 200, quantity: 2, category: 'FOOD' }],
            options: [{ id: 'xl', label: 'XL', group_name: 'Format', price_delta: 500 }],
          }),
        ]),
      ),
      catalogue(),
    );
    expect(h.plats[0]).toMatchObject({
      dish_id: 'burger',
      epice: true,
      supplements: [{ id: 'sauce', quantity: 2 }],
      option_item_ids: ['xl'],
    });
  });

  it('un plat retiré du menu, ou hors de l’audience du client, sort des habitudes', () => {
    const commandes = recentesDabord(
      commande(1, [ligne('campus'), ligne('burger')]),
      commande(2, [ligne('campus'), ligne('burger')]),
    );
    const h = etablirHabitudes(commandes, catalogue({ plats: new Set(['burger']) }));
    expect(h.plats.map((p) => p.dish_id)).toEqual(['burger']);
  });

  it('un plat offert (prix à zéro) n’est pas une habitude', () => {
    const h = etablirHabitudes(
      recentesDabord(
        commande(1, [ligne('burger', { amount: 0 }), ligne('frites')]),
        commande(2, [ligne('burger', { amount: 0 }), ligne('frites')]),
      ),
      catalogue(),
    );
    expect(h.plats.map((p) => p.dish_id)).toEqual(['frites']);
  });

  it('un supplément en rupture, ou exclu du plat depuis, n’est pas repris', () => {
    const lignes = [
      ligne('burger', {
        supplements: [
          { id: 'sauce', quantity: 1 },
          { id: 'coca', quantity: 2 },
          { id: 'retire', quantity: 1 },
        ],
      }),
    ];
    const h = etablirHabitudes(
      recentesDabord(commande(1, lignes), commande(2, lignes)),
      catalogue({ exclusions: new Set([cleExclusion('burger', 'coca')]) }),
    );
    expect(h.plats[0].supplements).toEqual([{ id: 'sauce', quantity: 1 }]);
  });

  it('aucune commande : rien', () => {
    expect(etablirHabitudes([], catalogue())).toEqual({ commandes: 0, plats: [], derniere: null });
  });
});

describe('habitudes du client : dernière commande', () => {
  it('la plus récente, avec ses lignes prêtes à reprendre', () => {
    const h = etablirHabitudes(
      recentesDabord(
        commande(1, [ligne('poulet')]),
        commande(5, [ligne('burger', { quantity: 2, epice: true }), ligne('frites')], {
          type: OrderType.PICKUP,
          amount: 10000,
        }),
      ),
      catalogue(),
    );
    expect(h.derniere).toMatchObject({
      id: 'o5',
      reference: 'ORD-5',
      type: OrderType.PICKUP,
      montant: 10000,
      restaurant: { id: 'r1', name: 'CHICKEN NATION ANGRÉ' },
    });
    expect(h.derniere?.lignes).toEqual([
      {
        dish_id: 'burger',
        nom: 'Burger Patron',
        quantity: 2,
        epice: true,
        supplements: [],
        option_item_ids: [],
        disponible: true,
      },
      {
        dish_id: 'frites',
        nom: 'Frites et boisson',
        quantity: 1,
        epice: false,
        supplements: [],
        option_item_ids: [],
        disponible: true,
      },
    ]);
  });

  it('un plat qui n’est plus au menu reste lisible, marqué indisponible', () => {
    const h = etablirHabitudes(
      [commande(1, [ligne('campus'), ligne('burger')])],
      catalogue({ plats: new Set(['burger']) }),
    );
    expect(h.derniere?.lignes.map((l) => [l.dish_id, l.disponible])).toEqual([
      ['campus', false],
      ['burger', true],
    ]);
  });

  it('les plats offerts n’y figurent pas ; une commande faite seulement de cadeaux est sautée', () => {
    const h = etablirHabitudes(
      recentesDabord(
        commande(1, [ligne('poulet'), ligne('burger', { amount: 0 })]),
        commande(2, [ligne('burger', { amount: 0 })]),
      ),
      catalogue(),
    );
    expect(h.derniere?.id).toBe('o1');
    expect(h.derniere?.lignes.map((l) => l.dish_id)).toEqual(['poulet']);
  });
});

describe('habitudes du client : lecture des lignes passées', () => {
  it('suppléments : identifiant seul, quantité absente ou invalide, doublon', () => {
    expect(
      lireSupplements([
        'a',
        { id: 'b' },
        { id: 'c', quantity: 3 },
        { id: 'c', quantity: 1 },
        { id: 'd', quantity: 0 },
        { id: 'e', quantity: 'deux' },
        { name: 'sans identifiant' },
        null,
      ]),
    ).toEqual([
      { id: 'a', quantity: 1 },
      { id: 'b', quantity: 1 },
      { id: 'c', quantity: 4 },
      { id: 'd', quantity: 1 },
      { id: 'e', quantity: 1 },
    ]);
    expect(lireSupplements(null)).toEqual([]);
    expect(lireSupplements({ id: 'a' })).toEqual([]);
  });

  it('choix d’un plat composable : identifiants seuls, sans doublon', () => {
    expect(lireOptions([{ id: 'xl', label: 'XL' }, { id: 'xl' }, { label: 'sans identifiant' }, null])).toEqual([
      'xl',
    ]);
    expect(lireOptions(undefined)).toEqual([]);
  });
});
