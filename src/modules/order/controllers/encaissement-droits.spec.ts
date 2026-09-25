/**
 * Qui peut encaisser : les trois routes d'encaissement, et la modification de
 * commande qui savait aussi rendre une commande payée, exigent COMMANDES
 * UPDATE_FULL, que la cuisine n'a pas.
 *
 * COMMANDES UPDATE, exigé jusqu'ici, laissait passer la CUISINE : la caisse
 * lui affiche l'onglet Paiement sans contrôle de rôle. Le test vérifie aussi
 * qu'aucun autre rôle n'a perdu l'encaissement au passage. Il s'appuie sur la
 * vraie garde et la vraie table des droits.
 */

import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { User, UserRole, UserType } from '@prisma/client';
import type { Request } from 'express';
import { permissionsByRole } from 'src/modules/auth/constantes/permissionsByRole';
import { REQUIRE_PERMISSION_KEY } from 'src/modules/auth/decorators/user-require-permission';
import { Action } from 'src/modules/auth/enums/action.enum';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { UserRolesGuard } from 'src/modules/auth/guards/user-roles.guard';
import { PaiementsController } from 'src/modules/paiements/controllers/paiements.controller';
import { UpdateOrderDto } from '../dto/update-order.dto';
import { OrderController } from './order.controller';

const ROUTES_ENCAISSEMENT: [string, (...args: never[]) => unknown][] = [
  ['POST /paiements/add', PaiementsController.prototype.addPaiement],
  ['PATCH /paiements/:id/confirmer-encaissement', PaiementsController.prototype.confirmerEncaissement],
  ['POST /orders/:id/mark-paid-cash', OrderController.prototype.markPaidCash],
  // Pas une route d'encaissement, mais elle posait `paied` : même droit.
  ['PATCH /orders/:id', OrderController.prototype.update],
];

const garde = new UserPermissionsGuard(new Reflector());

function autorise(role: UserRole, route: (...args: never[]) => unknown): boolean {
  const contexte = {
    getHandler: () => route,
    switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
  } as unknown as ExecutionContext;
  return garde.canActivate(contexte);
}

/** Actions du rôle sur les commandes, `ALL` compris (administrateur). */
const actionsCommandes = (role: UserRole): string[] => {
  const modules = permissionsByRole[role].modules;
  return modules[Modules.COMMANDES] ?? modules[Modules.ALL] ?? [];
};

describe("Droits d'encaissement", () => {
  it.each(ROUTES_ENCAISSEMENT)('%s exige COMMANDES UPDATE_FULL', (_route, methode) => {
    expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, methode)).toEqual({
      module: Modules.COMMANDES,
      action: Action.UPDATE_FULL,
    });
  });

  it.each(ROUTES_ENCAISSEMENT)('%s est refusé à la cuisine', (_route, methode) => {
    expect(autorise(UserRole.CUISINE, methode)).toBe(false);
  });

  it.each(ROUTES_ENCAISSEMENT)('%s reste ouvert à tous les rôles qui encaissent', (_route, methode) => {
    for (const role of [
      UserRole.CAISSIER,
      UserRole.MANAGER,
      UserRole.ASSISTANT_MANAGER,
      UserRole.CALL_CENTER,
      UserRole.ADMIN,
    ]) {
      expect(autorise(role, methode)).toBe(true);
    }
  });

  it("n'a retiré l'encaissement qu'à la cuisine : tout autre rôle qui avait UPDATE a UPDATE_FULL", () => {
    const perdants = Object.values(UserRole).filter((role) => {
      const actions = actionsCommandes(role);
      return actions.includes(Action.UPDATE) && !actions.includes(Action.UPDATE_FULL);
    });
    expect(perdants).toEqual([UserRole.CUISINE]);
  });
});

describe('PATCH /orders/:id', () => {
  const RESTAURANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

  function modifier(role: UserRole, type: UserType, corps: Record<string, unknown>) {
    const orderService = { update: jest.fn().mockResolvedValue({ id: 'o1' }) };
    const controleur = new OrderController(
      {} as never,
      orderService as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const user = { id: 'u1', role, type, restaurant_id: type === UserType.RESTAURANT ? RESTAURANT_A : null } as unknown as User;
    void controleur.update({ user } as unknown as Request, 'o1', corps as UpdateOrderDto);
    const [id, champs, options] = orderService.update.mock.calls[0];
    return { id, champs, options, user };
  }

  const corps = {
    note: 'Sans oignons',
    paied: true,
    paied_at: '2026-09-25T10:00:00.000Z',
    amount: 0,
  };

  it("n'écrit jamais paied, paied_at ni amount pour un compte de restaurant", () => {
    const { champs } = modifier(UserRole.CAISSIER, UserType.RESTAURANT, corps);
    expect(champs).toEqual({ note: 'Sans oignons' });
  });

  it('ne les écrit pas non plus pour le centre d\'appel', () => {
    const { champs } = modifier(UserRole.CALL_CENTER, UserType.BACKOFFICE, corps);
    expect(champs).toEqual({ note: 'Sans oignons' });
  });

  it("les laisse à l'administrateur, qui corrige les erreurs de saisie", () => {
    const { champs, options } = modifier(UserRole.ADMIN, UserType.BACKOFFICE, corps);
    expect(champs).toEqual(corps);
    expect(options.skipStatusCheck).toBe(true);
  });

  it('transmet le compte au service, qui contrôle le restaurant de la commande', () => {
    const { options, user } = modifier(UserRole.MANAGER, UserType.RESTAURANT, { note: 'x' });
    expect(options.user).toBe(user);
    expect(options.skipStatusCheck).toBe(false);
  });
});

describe('POST /orders/backfill-delivery-fees', () => {
  const garde = new UserRolesGuard(new Reflector());
  const autoriseRole = (role: UserRole) =>
    garde.canActivate({
      getHandler: () => OrderController.prototype.backfillDeliveryFees,
      getClass: () => OrderController,
      switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
    } as unknown as ExecutionContext);

  it("est réservé à l'administrateur : ni la cuisine ni la caisse ne lancent un rattrapage réseau", () => {
    expect(autoriseRole(UserRole.ADMIN)).toBe(true);
    for (const role of Object.values(UserRole).filter((r) => r !== UserRole.ADMIN)) {
      expect(autoriseRole(role)).toBe(false);
    }
  });
});
