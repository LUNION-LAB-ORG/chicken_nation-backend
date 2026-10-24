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
  it('ouvert au siège (administrateur, suivi des livraisons) et aux comptes de restaurant qui en ont besoin', () => {
    const ouverts = [UserRole.ADMIN, UserRole.LIVRAISON_OPS, UserRole.MANAGER, UserRole.ASSISTANT_MANAGER, UserRole.CAISSIER];
    expect(ouverts.map(passe)).toEqual(ouverts.map(() => true));
  });

  it('fermé aux autres rôles', () => {
    const fermes = [UserRole.CALL_CENTER, UserRole.CUISINE, UserRole.MARKETING, UserRole.COMPTABLE];
    expect(fermes.map(passe)).toEqual(fermes.map(() => false));
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
    };
    const reglagesLivreur = { load: jest.fn(async () => ({ gpsExpirationMinutes: 5 })) };
    const service = new TableauLivraisonService(
      prisma as never,
      livreurs as never,
      reglagesCourse as never,
      reglagesLivreur as never,
    );
    return { prisma, livreurs, service };
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

  it('une lecture ratée n’est pas gardée', async () => {
    const t = monter();
    t.prisma.course.findMany.mockRejectedValueOnce(new Error('base injoignable'));
    await expect(t.service.lire('r-angre')).rejects.toThrow('base injoignable');
    await expect(t.service.lire('r-angre')).resolves.toMatchObject({ restaurants: [{ id: 'r-angre' }] });
  });
});
