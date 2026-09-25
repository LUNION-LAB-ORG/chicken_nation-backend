import { ForbiddenException } from '@nestjs/common';
import { UserRole, UserType } from '@prisma/client';
import {
  assertPeutAttribuerRole,
  assertPeutGererMembre,
  AUCUN_RESTAURANT,
  ComptePersonnel,
  MESSAGE_HORS_RESTAURANT,
  peutGererMembre,
  restaurantDuNouveauMembre,
  restaurantDuPersonnelVisible,
  rolesAttribuables,
} from './personnel-scope.helper';

const R1 = 'resto-1';
const R2 = 'resto-2';

function compte(role: UserRole, restaurant_id: string | null, id = `${role}-${restaurant_id}`): ComptePersonnel {
  const type = [UserRole.MANAGER, UserRole.ASSISTANT_MANAGER, UserRole.CAISSIER, UserRole.CUISINE].includes(role as any)
    ? UserType.RESTAURANT
    : UserType.BACKOFFICE;
  return { id, role, restaurant_id, type };
}

const admin = compte(UserRole.ADMIN, null);
const manager = compte(UserRole.MANAGER, R1);
const autreManager = compte(UserRole.MANAGER, R1, 'manager-bis');
const assistant = compte(UserRole.ASSISTANT_MANAGER, R1);
const caissier = compte(UserRole.CAISSIER, R1);
const cuisine = compte(UserRole.CUISINE, R1);
const caissierAilleurs = compte(UserRole.CAISSIER, R2);
const marketing = compte(UserRole.MARKETING, null);
const callCenter = compte(UserRole.CALL_CENTER, null);

describe('rolesAttribuables', () => {
  it("l'ADMIN attribue tous les rôles", () => {
    expect(rolesAttribuables(admin).sort()).toEqual(Object.values(UserRole).sort());
  });

  it('un manager attribue assistant, caissier et cuisine, jamais manager ni un rôle du siège', () => {
    expect(rolesAttribuables(manager).sort()).toEqual(
      [UserRole.ASSISTANT_MANAGER, UserRole.CAISSIER, UserRole.CUISINE].sort(),
    );
  });

  it('un assistant attribue caissier et cuisine seulement', () => {
    expect(rolesAttribuables(assistant).sort()).toEqual([UserRole.CAISSIER, UserRole.CUISINE].sort());
  });

  it("un compte sans restaurant ou sans rang n'attribue rien", () => {
    expect(rolesAttribuables(compte(UserRole.MANAGER, null))).toEqual([]);
    expect(rolesAttribuables(caissier)).toEqual([]);
    expect(rolesAttribuables(marketing)).toEqual([]);
  });

  it("refuse la création d'un ADMIN ou d'un MANAGER par un manager", () => {
    expect(() => assertPeutAttribuerRole(manager, UserRole.ADMIN)).toThrow(ForbiddenException);
    expect(() => assertPeutAttribuerRole(manager, UserRole.MANAGER)).toThrow(ForbiddenException);
    expect(() => assertPeutAttribuerRole(manager, UserRole.CALL_CENTER)).toThrow(ForbiddenException);
    expect(() => assertPeutAttribuerRole(assistant, UserRole.ASSISTANT_MANAGER)).toThrow(ForbiddenException);
    expect(() => assertPeutAttribuerRole(manager, UserRole.CAISSIER)).not.toThrow();
    expect(() => assertPeutAttribuerRole(admin, UserRole.ADMIN)).not.toThrow();
  });
});

describe('peutGererMembre', () => {
  it("l'ADMIN gère tout le monde, siège compris", () => {
    for (const cible of [manager, assistant, caissierAilleurs, marketing, compte(UserRole.ADMIN, null, 'a2')]) {
      expect(peutGererMembre(admin, cible)).toBe(true);
    }
  });

  it('un manager gère le personnel de rang inférieur de SON restaurant', () => {
    expect(peutGererMembre(manager, assistant)).toBe(true);
    expect(peutGererMembre(manager, caissier)).toBe(true);
    expect(peutGererMembre(manager, cuisine)).toBe(true);
  });

  it("un manager ne gère ni un autre manager, ni un autre restaurant, ni le siège", () => {
    expect(peutGererMembre(manager, autreManager)).toBe(false);
    expect(peutGererMembre(manager, caissierAilleurs)).toBe(false);
    expect(peutGererMembre(manager, marketing)).toBe(false);
    expect(peutGererMembre(manager, callCenter)).toBe(false);
    expect(peutGererMembre(manager, admin)).toBe(false);
  });

  it('un assistant ne touche pas un manager ni un autre assistant', () => {
    expect(peutGererMembre(assistant, manager)).toBe(false);
    expect(peutGererMembre(assistant, compte(UserRole.ASSISTANT_MANAGER, R1, 'assistant-bis'))).toBe(false);
    expect(peutGererMembre(assistant, caissier)).toBe(true);
  });

  it('un membre de restaurant sans restaurant ne gère personne', () => {
    const managerOrphelin = compte(UserRole.MANAGER, null);
    expect(peutGererMembre(managerOrphelin, compte(UserRole.CAISSIER, null))).toBe(false);
  });

  it('refuse avec le message attendu', () => {
    expect(() => assertPeutGererMembre(assistant, manager)).toThrow(MESSAGE_HORS_RESTAURANT);
    expect(MESSAGE_HORS_RESTAURANT).toBe('Vous ne pouvez gérer que le personnel de votre restaurant.');
  });
});

describe('restaurantDuPersonnelVisible', () => {
  it('force le restaurant du compte de restaurant, quel que soit le paramètre', () => {
    expect(restaurantDuPersonnelVisible(manager, R2)).toBe(R1);
    expect(restaurantDuPersonnelVisible(assistant)).toBe(R1);
  });

  it('un compte de restaurant sans restaurant ne voit personne', () => {
    expect(restaurantDuPersonnelVisible(compte(UserRole.MANAGER, null))).toBe(AUCUN_RESTAURANT);
  });

  it('un rôle de magasin enregistré par erreur comme siège reste cloisonné', () => {
    expect(restaurantDuPersonnelVisible({ ...manager, type: UserType.BACKOFFICE }, R2)).toBe(R1);
  });

  it('le siège garde le filtre de son onglet ou voit tout le réseau', () => {
    expect(restaurantDuPersonnelVisible(admin, R2)).toBe(R2);
    expect(restaurantDuPersonnelVisible(admin)).toBeUndefined();
    expect(restaurantDuPersonnelVisible(admin, '')).toBeUndefined();
  });
});

describe('restaurantDuNouveauMembre', () => {
  it('un manager crée TOUJOURS dans son restaurant', () => {
    expect(restaurantDuNouveauMembre(manager, UserRole.CAISSIER, undefined)).toBe(R1);
    expect(restaurantDuNouveauMembre(manager, UserRole.CAISSIER, R1)).toBe(R1);
  });

  it("un manager qui vise un autre restaurant est refusé", () => {
    expect(() => restaurantDuNouveauMembre(manager, UserRole.CAISSIER, R2)).toThrow(MESSAGE_HORS_RESTAURANT);
  });

  it("l'ADMIN choisit le restaurant d'un rôle de magasin, et un rôle du siège n'en a pas", () => {
    expect(restaurantDuNouveauMembre(admin, UserRole.CAISSIER, R2)).toBe(R2);
    expect(restaurantDuNouveauMembre(admin, UserRole.CAISSIER, undefined)).toBeNull();
    expect(restaurantDuNouveauMembre(admin, UserRole.MARKETING, R2)).toBeNull();
  });

  it("par défaut (POST /users/member), l'ADMIN rattaché à un restaurant y crée le membre", () => {
    const adminRattache = compte(UserRole.ADMIN, R1, 'admin-r1');
    expect(restaurantDuNouveauMembre(adminRattache, UserRole.CUISINE, undefined, { restaurantParDefaut: true })).toBe(R1);
    expect(restaurantDuNouveauMembre(adminRattache, UserRole.CUISINE, undefined)).toBeNull();
  });
});
