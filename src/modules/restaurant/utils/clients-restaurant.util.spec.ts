import {
  CLIENT_DE_RESTAURANT_SELECT,
  CLIENTS_RESTAURANT_LIMITE_DEFAUT,
  CLIENTS_RESTAURANT_LIMITE_MAX,
  filtreClientsRestaurant,
  motsDeRecherche,
  paginationClientsRestaurant,
} from './clients-restaurant.util';

describe('paginationClientsRestaurant', () => {
  it('50 par défaut, 100 au plus, page à partir de 1', () => {
    expect(paginationClientsRestaurant()).toEqual({ page: 1, limit: CLIENTS_RESTAURANT_LIMITE_DEFAUT, skip: 0 });
    expect(paginationClientsRestaurant('3', '20')).toEqual({ page: 3, limit: 20, skip: 40 });
    expect(paginationClientsRestaurant('1', '100000')).toEqual({ page: 1, limit: CLIENTS_RESTAURANT_LIMITE_MAX, skip: 0 });
    expect(paginationClientsRestaurant('-2', '0')).toEqual({ page: 1, limit: CLIENTS_RESTAURANT_LIMITE_DEFAUT, skip: 0 });
  });
});

describe('motsDeRecherche', () => {
  it('découpe la saisie, et la borne', () => {
    expect(motsDeRecherche('  Awa   Koné ')).toEqual(['Awa', 'Koné']);
    expect(motsDeRecherche('')).toEqual([]);
    expect(motsDeRecherche(undefined)).toEqual([]);
    expect(motsDeRecherche(['a'])).toEqual([]);
    expect(motsDeRecherche('a b c d e f g')).toHaveLength(5);
  });
});

describe('filtreClientsRestaurant', () => {
  it('sans recherche : clients actifs ayant commandé dans CE restaurant', () => {
    expect(filtreClientsRestaurant('r1')).toEqual({
      entity_status: 'ACTIVE',
      orders: { some: { restaurant_id: 'r1' } },
    });
  });

  it('chaque mot doit se retrouver dans le prénom, le nom, l’e-mail ou le téléphone', () => {
    const where = filtreClientsRestaurant('r1', 'Awa 07-08');
    expect(where.entity_status).toBe('ACTIVE');
    expect(where.orders).toEqual({ some: { restaurant_id: 'r1' } });
    expect(where.AND).toEqual([
      {
        OR: [
          { first_name: { contains: 'Awa', mode: 'insensitive' } },
          { last_name: { contains: 'Awa', mode: 'insensitive' } },
          { email: { contains: 'Awa', mode: 'insensitive' } },
        ],
      },
      {
        OR: [
          { first_name: { contains: '07-08', mode: 'insensitive' } },
          { last_name: { contains: '07-08', mode: 'insensitive' } },
          { email: { contains: '07-08', mode: 'insensitive' } },
          { phone: { contains: '0708' } },
        ],
      },
    ]);
  });
});

describe('CLIENT_DE_RESTAURANT_SELECT', () => {
  it('ne sort que ce qu’affiche la liste déroulante', () => {
    expect(Object.keys(CLIENT_DE_RESTAURANT_SELECT).sort()).toEqual(
      ['email', 'first_name', 'id', 'image', 'last_name', 'phone'].sort(),
    );
  });
});
