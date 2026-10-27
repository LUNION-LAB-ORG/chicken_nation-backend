/**
 * `GET /livraison/tableau` : qui le lit, quel périmètre, et le résultat gardé
 * 10 s par périmètre (conception du 24/10, 4.2 et 11.4).
 */
import { Reflector } from '@nestjs/core';
import { UserRole, UserType } from '@prisma/client';

import { UserRolesGuard } from 'src/modules/auth/guards/user-roles.guard';

import { TableauLivraisonService } from '../services/tableau-livraison.service';
import { LivraisonTableauController } from './livraison-tableau.controller';

function passe(role: UserRole): boolean {
  const garde = new UserRolesGuard(new Reflector());
  const contexte = {
    getHandler: () => LivraisonTableauController.prototype.lire,
    getClass: () => LivraisonTableauController,
    switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
  } as never;
  return garde.canActivate(contexte);
}

describe('GET /livraison/tableau : rôles', () => {
  it('ouvert au siège (administrateur, suivi des livraisons, call center) et aux comptes de restaurant qui en ont besoin', () => {
    const ouverts = [
      UserRole.ADMIN,
      UserRole.LIVRAISON_OPS,
      UserRole.CALL_CENTER,
      UserRole.MANAGER,
      UserRole.ASSISTANT_MANAGER,
      UserRole.CAISSIER,
    ];
    expect(ouverts.map(passe)).toEqual(ouverts.map(() => true));
  });

  it('fermé aux autres rôles', () => {
    const fermes = [UserRole.CUISINE, UserRole.MARKETING, UserRole.COMPTABLE];
    expect(fermes.map(passe)).toEqual(fermes.map(() => false));
    expect(Object.values(UserRole).filter((r) => !passe(r)).sort()).toEqual([...fermes].sort());
  });

  it('aucune route d’écriture sur ce contrôleur : la liste de rôles ne garde qu’une lecture', () => {
    const proto = LivraisonTableauController.prototype as unknown as Record<string, unknown>;
    const methodes = Object.getOwnPropertyNames(proto).filter((m) => m !== 'constructor' && typeof proto[m] === 'function');
    expect(methodes).toEqual(['lire']);
  });
});

describe('GET /livraison/tableau : périmètre', () => {
  const monter = () => {
    const tableau = { lire: jest.fn(async () => ({ genere_a: '', restaurants: [], signaux: [] })) };
    return { tableau, controleur: new LivraisonTableauController(tableau as never) };
  };

  it('un compte de restaurant ne lit que le sien, même s’il en demande un autre', async () => {
    const t = monter();
    const caissiere = { type: UserType.RESTAURANT, role: UserRole.CAISSIER, restaurant_id: 'r-angre' };
    await t.controleur.lire({ user: caissiere } as never, 'r-marcory');
    await t.controleur.lire({ user: caissiere } as never);
    expect(t.tableau.lire.mock.calls).toEqual([['r-angre'], ['r-angre']]);
  });

  it('le siège lit tout le réseau, ou le restaurant demandé', async () => {
    const t = monter();
    const admin = { type: UserType.BACKOFFICE, role: UserRole.ADMIN, restaurant_id: null };
    await t.controleur.lire({ user: admin } as never);
    await t.controleur.lire({ user: admin } as never, 'r-marcory');
    expect(t.tableau.lire.mock.calls).toEqual([[undefined], ['r-marcory']]);
  });

  it('le call center, compte de siège, lit lui aussi tous les restaurants', async () => {
    const t = monter();
    const agent = { type: UserType.BACKOFFICE, role: UserRole.CALL_CENTER, restaurant_id: null };
    await t.controleur.lire({ user: agent } as never);
    await t.controleur.lire({ user: agent } as never, 'r-marcory');
    expect(t.tableau.lire.mock.calls).toEqual([[undefined], ['r-marcory']]);
  });
});

describe('TableauLivraisonService : résultat gardé 10 s par périmètre', () => {
  const M = new Date('2026-10-24T12:00:00.000Z');

  beforeEach(() => jest.useFakeTimers({ now: M, doNotFake: ['nextTick', 'setImmediate'] }));
  afterEach(() => jest.useRealTimers());

  function monter() {
    const prisma = {
      restaurant: { findMany: jest.fn(async () => [{ id: 'r-angre', name: 'Angré' }]) },
      course: { findMany: jest.fn(async () => []) },
      order: { findMany: jest.fn(async () => []) },
      delivery: { findMany: jest.fn(async () => []) },
    };
    const livreurs = {
      getLiveLocations: jest.fn(async () => []),
      lirePlanningDuJour: jest.fn(async () => ({ jour: M, plans: [], repos: [], absents: [] })),
    };
    const reglagesCourse = {
      load: jest.fn(async () => ({ delayAlertFactor: 1.5, noDelivererAlertAfterMin: 5, autoCancelAtRestaurantAfterMin: 30 })),
      lirePlanification: jest.fn(async () => ({
        planificateur: { version: 'v2', restaurants: [] as string[], refusees: [] },
        planification: { reglages: { turboActif: true, turboApresMinV2: 6 } },
      })),
    };
    const reglagesLivreur = { load: jest.fn(async () => ({ gpsExpirationMinutes: 5 })) };
    const service = new TableauLivraisonService(
      prisma as never,
      livreurs as never,
      reglagesCourse as never,
      reglagesLivreur as never,
    );
    return { prisma, livreurs, reglagesCourse, service };
  }

  it('deux lectures dans les 10 s : une seule fois en base ; après 10 s : relu', async () => {
    const t = monter();
    const premier = await t.service.lire('r-angre');
    expect(premier.restaurants.map((r) => r.nom)).toEqual(['Angré']);
    await t.service.lire('r-angre');
    expect(t.prisma.course.findMany).toHaveBeenCalledTimes(1);

    jest.setSystemTime(new Date(M.getTime() + 10_000));
    await t.service.lire('r-angre');
    expect(t.prisma.course.findMany).toHaveBeenCalledTimes(2);
  });

  it('un périmètre par restaurant, un pour tout le réseau ; le périmètre va à chaque lecture', async () => {
    const t = monter();
    await t.service.lire('r-angre');
    await t.service.lire(undefined);
    expect(t.prisma.course.findMany).toHaveBeenCalledTimes(2);
    expect(t.livreurs.getLiveLocations.mock.calls).toEqual([
      [{ restaurantId: 'r-angre', includeOffline: true }],
      [{ restaurantId: undefined, includeOffline: true }],
    ]);
    expect(t.prisma.restaurant.findMany.mock.calls[0]).toEqual([
      expect.objectContaining({ where: { id: 'r-angre', entity_status: { not: 'DELETED' } } }),
    ]);
    expect(t.prisma.restaurant.findMany.mock.calls[1]).toEqual([
      expect.objectContaining({ where: { entity_status: 'ACTIVE' } }),
    ]);
  });

  it('seuil de « Sans livreur » : celui de la cloche, restaurant par restaurant', async () => {
    const sansLivreurDepuis6Min = {
      id: 'c-1',
      reference: 'CRS-241024-0001',
      statut: 'PENDING_ASSIGNMENT',
      restaurant_id: 'r-angre',
      deliverer: null,
      turbo_escalated_at: null,
      created_at: new Date(M.getTime() - 6 * 60_000),
      at_restaurant_at: null,
      picked_up_at: null,
      parti_at: null,
      motif_depart: null,
      estimated_duration_min: null,
      delay_alerted_at: null,
      cancelled_at: null,
      deliveries: [
        {
          statut: 'PENDING',
          ajoutee_apres_retrait: false,
          order: { reference: 'ORD-1', status: 'READY', entity_status: 'ACTIVE', delivery_service: 'CHICKEN_NATION' },
        },
      ],
    };
    const gravite = async (version: 'v1' | 'v2', turboActif: boolean) => {
      const t = monter();
      t.prisma.course.findMany.mockResolvedValue([sansLivreurDepuis6Min] as never);
      t.reglagesCourse.lirePlanification.mockResolvedValue({
        planificateur: { version, restaurants: [], refusees: [] },
        planification: { reglages: { turboActif, turboApresMinV2: 6 } },
      });
      const lu = await t.service.lire('r-angre');
      return lu.signaux.map((s) => [s.cle, s.gravite]);
    };
    // v2 avec Turbo : la cloche attend 7 min (Turbo à 6 min, plus une) ; sinon 5 min.
    expect(await gravite('v2', true)).toEqual([['SANS_LIVREUR', 'ambre']]);
    expect(await gravite('v2', false)).toEqual([['SANS_LIVREUR', 'rouge']]);
    expect(await gravite('v1', true)).toEqual([['SANS_LIVREUR', 'rouge']]);
  });

  it('la lecture des commandes porte leur service de livraison (course d’origine Turbo)', async () => {
    const t = monter();
    await t.service.lire('r-angre');
    const [arg] = t.prisma.course.findMany.mock.calls[0] as unknown as [
      { select: { deliveries: { select: { order: { select: Record<string, boolean> } } } } },
    ];
    expect(arg.select.deliveries.select.order.select).toEqual(expect.objectContaining({ delivery_service: true }));
  });

  it('« Annuler » du livreur (27/10) : courses terminées du jour qui ont une livraison en échec à commande en livraison, échec et motif lus', async () => {
    const t = monter();
    await t.service.lire('r-angre');
    const [arg] = t.prisma.course.findMany.mock.calls[0] as unknown as [
      { where: { OR: Record<string, unknown>[] }; select: { deliveries: { select: Record<string, unknown> } } },
    ];
    const debut = new Date('2026-10-24T05:00:00.000Z');
    expect(arg.where.OR).toContainEqual({
      statut: 'COMPLETED',
      completed_at: { gte: debut },
      deliveries: {
        some: {
          statut: 'FAILED',
          failed_at: { gte: debut },
          order: { status: 'PICKED_UP', entity_status: { not: 'DELETED' } },
        },
      },
    });
    expect(arg.select.deliveries.select).toEqual(expect.objectContaining({ failed_at: true, failure_reason: true }));
  });

  it('une lecture ratée n’est pas gardée', async () => {
    const t = monter();
    t.prisma.course.findMany.mockRejectedValueOnce(new Error('base injoignable'));
    await expect(t.service.lire('r-angre')).rejects.toThrow('base injoignable');
    await expect(t.service.lire('r-angre')).resolves.toMatchObject({ restaurants: [{ id: 'r-angre' }] });
  });
});
