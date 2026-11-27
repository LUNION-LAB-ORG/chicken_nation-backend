/**
 * Recherche de la liste des commandes (27/11) : nom ou numéro du client,
 * référence, et quelques autres repères. Règles pures et leurs tests :
 * helpers/recherche-commande.rules.ts.
 *
 * Ici, ce que `findAll` en fait : la recherche prime sur `reference`, lève la
 * borne du mois en cours tant qu'aucune période n'est choisie, lit les clients
 * accents ignorés, et ne cherche pas par numéro pour un rôle aux coordonnées
 * masquées.
 *
 * Comme order.service.filtre-source.spec.ts, la méthode est testée en
 * isolation : seules les dépendances qu'elle lit sont greffées.
 */

import { Prisma, User, UserRole } from '@prisma/client';
import { QueryOrderDto } from '../dto/query-order.dto';
import { OrderService } from './order.service';

const compte = (role: UserRole) => ({ id: `u-${role}`, role }) as unknown as User;
const AGENT = compte(UserRole.CALL_CENTER);
const MARKETING = compte(UserRole.MARKETING);

function monter(clients: { id: string }[] | Error = []) {
  const lus: Prisma.OrderWhereInput[] = [];
  const lectureClients = jest.fn(async (_requete: Prisma.Sql) => {
    if (clients instanceof Error) throw clients;
    return clients;
  });
  const service = Object.create(OrderService.prototype) as OrderService;
  Object.assign(service, {
    logger: { warn: jest.fn() },
    prisma: {
      $queryRaw: lectureClients,
      order: {
        findMany: jest.fn(async ({ where }: { where: Prisma.OrderWhereInput }) => {
          lus.push(where);
          return [];
        }),
        count: jest.fn(async () => 0),
      },
    },
  });
  const chercher = async (filtres: Partial<QueryOrderDto>, user: User = AGENT) => {
    await service.findAll(filtres as QueryOrderDto, user);
    const where = lus[lus.length - 1];
    return { where, texte: JSON.stringify(where) };
  };
  return { chercher, lectureClients };
}

describe('Liste des commandes : recherche', () => {
  it('sans recherche : la référence filtre comme avant, sur le mois en cours', async () => {
    const { chercher, lectureClients } = monter();
    const { where } = await chercher({ reference: 'ORD-2611' });
    expect(where.reference).toEqual({ contains: 'ORD-2611', mode: 'insensitive' });
    expect(where.created_at).toBeDefined();
    expect(lectureClients).not.toHaveBeenCalled();
  });

  it('une saisie trop courte ne filtre rien', async () => {
    const { chercher } = monter();
    const { where, texte } = await chercher({ search: 'a' });
    expect(texte).not.toContain('fullname');
    expect(where.created_at).toBeDefined();
  });

  it('la recherche prime sur `reference` (ancien paramètre encore envoyé par l\'écran)', async () => {
    const { chercher } = monter();
    const { where, texte } = await chercher({ search: 'Awa', reference: 'Awa' });
    expect(where.reference).toBeUndefined();
    expect(texte).toContain('"reference":{"contains":"Awa"');
    expect(texte).toContain('"fullname":{"contains":"Awa"');
  });

  it('sans période choisie, la recherche couvre toutes les dates', async () => {
    const { chercher } = monter();
    expect((await chercher({ search: '0707070707' })).where.created_at).toBeUndefined();
  });

  it('une période choisie reste appliquée à la recherche', async () => {
    const { chercher } = monter();
    const { where } = await chercher({
      search: '0707070707',
      startDate: new Date('2026-11-01T00:00:00Z'),
      endDate: new Date('2026-11-27T00:00:00Z'),
    });
    expect(where.created_at).toBeDefined();
  });

  it('se compose avec les autres filtres et la visibilité du rôle', async () => {
    const { chercher } = monter();
    const { where, texte } = await chercher({ search: 'ORD-2611', restaurantId: 'r1' }, compte(UserRole.CAISSIER));
    expect(where.restaurant_id).toBe('r1');
    // Un rôle hors siège ne voit toujours pas les commandes en attente.
    expect(texte).toContain('"status":{"not":"PENDING"}');
  });

  describe('nom du client', () => {
    it('lit les clients accents ignorés, puis cherche leurs commandes', async () => {
      const { chercher, lectureClients } = monter([{ id: 'c1' }, { id: 'c2' }]);
      const { texte } = await chercher({ search: 'Kone Awa' });
      expect(lectureClients).toHaveBeenCalledTimes(1);
      const requete = lectureClients.mock.calls[0][0];
      expect(requete.values).toEqual(expect.arrayContaining(['%kone%', '%awa%']));
      expect(texte).toContain('"customer_id":{"in":["c1","c2"]}');
    });

    it('trop de clients pour une liste : comparaison directe du nom', async () => {
      const { chercher } = monter(Array.from({ length: 1001 }, (_, i) => ({ id: `c${i}` })));
      const { texte } = await chercher({ search: 'ko' });
      expect(texte).not.toContain('customer_id');
      expect(texte).toContain('"first_name":{"contains":"ko"');
    });

    it('lecture en échec : comparaison directe, la liste répond quand même', async () => {
      const { chercher } = monter(new Error('base indisponible'));
      const { texte } = await chercher({ search: 'Kone' });
      expect(texte).toContain('"last_name":{"contains":"Kone"');
    });

    it("un numéro ne déclenche pas la lecture des clients par nom", async () => {
      const { chercher, lectureClients } = monter();
      const { texte } = await chercher({ search: '07 07 07 07 07' });
      expect(lectureClients).not.toHaveBeenCalled();
      expect(texte).toContain('"customer":{"phone":{"contains":"0707070707"}}');
    });
  });

  it('rôle aux coordonnées masquées : pas de recherche par numéro', async () => {
    const { chercher } = monter();
    const { texte } = await chercher({ search: '0707070707' }, MARKETING);
    expect(texte).not.toContain('phone');
    expect(texte).toContain('"reference":{"contains":"0707070707"');
  });
});
