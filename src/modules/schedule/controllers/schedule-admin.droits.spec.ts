import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';

import { REQUIRE_PERMISSION_KEY } from 'src/modules/auth/decorators/user-require-permission';
import { USER_ROLES_KEY } from 'src/modules/auth/decorators/user-roles.decorator';
import { Action } from 'src/modules/auth/enums/action.enum';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';

import { ScheduleAdminController } from './schedule-admin.controller';

/**
 * Le planning est gardé par le droit `Modules.PLANNING` (24/10), plus par une
 * liste de rôles. Ce test rejoue le VRAI garde sur les VRAIES méthodes du
 * contrôleur.
 *
 * ⚠️ `UserPermissionsGuard` laisse passer une route sans permission : une
 * route ajoutée sans `@RequirePermission` serait ouverte à tout le personnel.
 * Le premier test l'attrape.
 */
const proto = ScheduleAdminController.prototype as unknown as Record<string, unknown>;

const LECTURES = ['apercu', 'listPlans', 'getPlanDetail', 'getPlanStats'];
const CREATION = ['generatePlan'];
const MODIFICATIONS = [
  'sendPlan',
  'confirmPlan',
  'archivePlan',
  'setDelivererDay',
  'livreursAjoutables',
  'addDeliverer',
  'removeDeliverer',
  'regeneratePlan',
];
const SUPPRESSION = ['deletePlan'];
const TOUTES = [...LECTURES, ...CREATION, ...MODIFICATIONS, ...SUPPRESSION];

function passe(methode: string, role: UserRole): boolean {
  const garde = new UserPermissionsGuard(new Reflector());
  const contexte = {
    getHandler: () => proto[methode],
    getClass: () => ScheduleAdminController,
    switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
  } as never;
  return garde.canActivate(contexte);
}

describe('planning : garde par le droit PLANNING', () => {
  it('chaque route du contrôleur est nommée ici et porte sa permission PLANNING', () => {
    const methodes = Object.getOwnPropertyNames(proto).filter(
      (m) => m !== 'constructor' && typeof proto[m] === 'function',
    );
    expect(methodes.sort()).toEqual([...TOUTES].sort());
    const attendue = (m: string) =>
      LECTURES.includes(m)
        ? Action.READ
        : CREATION.includes(m)
          ? Action.CREATE
          : SUPPRESSION.includes(m)
            ? Action.DELETE
            : Action.UPDATE;
    for (const m of TOUTES) {
      expect([m, Reflect.getMetadata(REQUIRE_PERMISSION_KEY, proto[m] as object)]).toEqual([
        m,
        { module: Modules.PLANNING, action: attendue(m) },
      ]);
    }
  });

  it('la classe passe par l’authentification puis par le droit, sans liste de rôles', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, ScheduleAdminController)).toEqual([
      JwtAuthGuard,
      UserPermissionsGuard,
    ]);
    expect(Reflect.getMetadata(USER_ROLES_KEY, ScheduleAdminController)).toBeUndefined();
    for (const m of TOUTES) {
      expect([m, Reflect.getMetadata(USER_ROLES_KEY, proto[m] as object)]).toEqual([m, undefined]);
    }
  });

  it('administrateur, manager et assistant : toutes les routes (le restaurant est vérifié ensuite)', () => {
    for (const role of [UserRole.ADMIN, UserRole.MANAGER, UserRole.ASSISTANT_MANAGER]) {
      for (const m of TOUTES) expect([role, m, passe(m, role)]).toEqual([role, m, true]);
    }
  });

  // Le call center lit le planning comme le suivi des livraisons (26/10).
  // `livreursAjoutables` est un GET, mais il sert l'ajout d'un livreur : fermé.
  it.each([UserRole.LIVRAISON_OPS, UserRole.CALL_CENTER])('%s : les lectures seulement', (role) => {
    for (const m of TOUTES) {
      expect([m, passe(m, role)]).toEqual([m, LECTURES.includes(m)]);
    }
  });

  it('les autres rôles : rien', () => {
    const autres = Object.values(UserRole).filter(
      (r) =>
        r !== UserRole.ADMIN &&
        r !== UserRole.MANAGER &&
        r !== UserRole.ASSISTANT_MANAGER &&
        r !== UserRole.LIVRAISON_OPS &&
        r !== UserRole.CALL_CENTER,
    );
    expect(autres.length).toBeGreaterThan(0);
    for (const role of autres) {
      for (const m of TOUTES) expect([role, m, passe(m, role)]).toEqual([role, m, false]);
    }
  });
});
