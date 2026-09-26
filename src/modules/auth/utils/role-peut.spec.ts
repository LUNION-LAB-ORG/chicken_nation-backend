import { UserRole } from '@prisma/client';
import { Reflector } from '@nestjs/core';
import { UserPermissionsGuard } from '../guards/user-permissions.guard';
import { Action } from '../enums/action.enum';
import { Modules } from '../enums/module-enum';
import { rolePeut } from './role-peut';

/** Rejoue le garde réel pour un rôle et une permission donnés. */
function gardeAutorise(role: UserRole, module: Modules, action: Action): boolean {
  const reflector = { get: () => ({ module, action }) } as unknown as Reflector;
  const garde = new UserPermissionsGuard(reflector);
  const contexte = {
    getHandler: () => undefined,
    switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
  } as any;
  return garde.canActivate(contexte);
}

describe('rolePeut', () => {
  it('messagerie en lecture : oui pour le personnel du service, non pour CUISINE, MARKETING et COMPTABLE', () => {
    const lecture = (role: UserRole) => rolePeut(role, Modules.MESSAGES, Action.READ);
    expect(lecture(UserRole.ADMIN)).toBe(true);
    expect(lecture(UserRole.CALL_CENTER)).toBe(true);
    expect(lecture(UserRole.MANAGER)).toBe(true);
    expect(lecture(UserRole.ASSISTANT_MANAGER)).toBe(true);
    expect(lecture(UserRole.CAISSIER)).toBe(true);
    expect(lecture(UserRole.CUISINE)).toBe(false);
    expect(lecture(UserRole.MARKETING)).toBe(false);
    expect(lecture(UserRole.COMPTABLE)).toBe(false);
  });

  it('rôle absent ou inconnu : non', () => {
    expect(rolePeut(null, Modules.MESSAGES, Action.READ)).toBe(false);
    expect(rolePeut(undefined, Modules.MESSAGES, Action.READ)).toBe(false);
    expect(rolePeut('INVENTE', Modules.MESSAGES, Action.READ)).toBe(false);
  });

  it('donne exactement la même réponse que le garde, pour tous les rôles, modules et actions', () => {
    const modules = Object.values(Modules) as Modules[];
    const actions = Object.values(Action) as Action[];
    for (const role of Object.values(UserRole)) {
      for (const module of modules) {
        for (const action of actions) {
          expect([role, module, action, rolePeut(role, module, action)]).toEqual([
            role,
            module,
            action,
            gardeAutorise(role, module, action),
          ]);
        }
      }
    }
  });
});
