import { UserRole, UserType } from '@prisma/client';
import { isStoreRole, resolveStaffType } from 'src/modules/users/helpers/staff-type.helper';
import { Reflector } from '@nestjs/core';
import { UserPermissionsGuard } from '../guards/user-permissions.guard';
import { Action } from '../enums/action.enum';
import { Modules } from '../enums/module-enum';
import { permissionsByRole } from '../constantes/permissionsByRole';
import { filtrerParDroit, rolePeut } from './role-peut';

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

describe('rôle MARKETING (décision du 28/09)', () => {
  const modules = Object.values(Modules) as Modules[];
  const actions = Object.values(Action) as Action[];
  const peut = (module: Modules, action: Action) => rolePeut(UserRole.MARKETING, module, action);

  it('perd le tableau de bord, les commandes, les restaurants, les inventaires et les diffusions', () => {
    for (const module of [Modules.DASHBOARD, Modules.COMMANDES, Modules.RESTAURANTS, Modules.INVENTAIRE, Modules.DIFFUSIONS]) {
      for (const action of actions) {
        expect([module, action, peut(module, action)]).toEqual([module, action, false]);
      }
    }
  });

  it('n’a toujours ni messagerie, ni appels, ni paramètres', () => {
    for (const module of [Modules.MESSAGES, Modules.CALLS, Modules.SETTINGS]) {
      expect([module, peut(module, Action.READ)]).toEqual([module, false]);
    }
  });

  it('garde la consultation de Menus, Base de données, Fidélisation, Marketing et Notifications', () => {
    const lus = [
      Modules.MENUS,
      Modules.CLIENTS,
      Modules.COMMENTAIRES,
      Modules.CRM,
      Modules.PROMOTIONS,
      Modules.FIDELITE,
      Modules.CARD_NATION,
      Modules.MARKETING,
      Modules.NOTIFICATIONS,
      Modules.BASE_DONNEES,
    ];
    for (const module of lus) expect([module, peut(module, Action.READ)]).toEqual([module, true]);
    for (const module of [Modules.CRM, Modules.CARD_NATION, Modules.MARKETING, Modules.BASE_DONNEES]) {
      expect([module, peut(module, Action.REPORT)]).toEqual([module, true]);
    }
  });

  /**
   * Décision du 06/10 : le marketing GÈRE les cartes de la nation —
   * approuver, rejeter, suspendre, révoquer, réactiver, régénérer. C'est la
   * seule entorse à « aucun geste nulle part », et elle s'arrête à la
   * suppression : effacer une demande ou une carte effacerait aussi la trace
   * de ce qui a été décidé.
   */
  it('peut gérer les cartes de la nation, mais jamais les supprimer', () => {
    expect(peut(Modules.CARD_NATION, Action.UPDATE)).toBe(true);
    expect(peut(Modules.CARD_NATION, Action.DELETE)).toBe(false);
    expect(peut(Modules.CARD_NATION, Action.CREATE)).toBe(false);
  });

  it('aucun autre geste, nulle part', () => {
    const autorises = new Set<Action>([Action.READ, Action.REPORT]);
    for (const module of modules) {
      for (const action of actions) {
        // Seule exception, décidée le 06/10 : la gestion des cartes.
        if (module === Modules.CARD_NATION && action === Action.UPDATE) continue;
        if (!autorises.has(action)) {
          expect([module, action, peut(module, action)]).toEqual([module, action, false]);
        }
      }
    }
    expect(Object.keys(permissionsByRole[UserRole.MARKETING].modules).sort()).toEqual(
      [
        Modules.BASE_DONNEES,
        Modules.CARD_NATION,
        Modules.CLIENTS,
        Modules.COMMENTAIRES,
        Modules.CRM,
        Modules.FIDELITE,
        Modules.MARKETING,
        Modules.MENUS,
        Modules.NOTIFICATIONS,
        Modules.PROMOTIONS,
      ].sort(),
    );
  });

  it('arrive sur Menus : c’est la première clé de son bloc', () => {
    expect(Object.keys(permissionsByRole[UserRole.MARKETING].modules)[0]).toBe(Modules.MENUS);
  });

  it('seul l’administrateur détient encore les diffusions', () => {
    for (const role of Object.values(UserRole)) {
      for (const action of actions) {
        expect([role, action, rolePeut(role, Modules.DIFFUSIONS, action)]).toEqual([
          role,
          action,
          role === UserRole.ADMIN,
        ]);
      }
    }
  });
});

describe('rôle LIVRAISON_OPS (demande du 08/10)', () => {
  const modules = Object.values(Modules) as Modules[];
  const actions = Object.values(Action) as Action[];
  const peut = (module: Modules, action: Action) =>
    rolePeut(UserRole.LIVRAISON_OPS, module, action);

  it('lit les commandes, les courses, les livreurs et leur planning', () => {
    expect(peut(Modules.COMMANDES, Action.READ)).toBe(true);
    // Un droit pour les courses et les livreurs, un autre pour le planning.
    expect(peut(Modules.LIVREURS, Action.READ)).toBe(true);
    expect(peut(Modules.PLANNING, Action.READ)).toBe(true);
  });

  /**
   * Le cœur de la demande : « il peut juste consulter sans modifier, pas
   * d'action à mener ». Chaque geste est nommé, pour qu'un ajout de droit se
   * voie en relecture plutôt que de passer dans un test générique.
   */
  it('ne mène aucune action sur une commande', () => {
    expect(peut(Modules.COMMANDES, Action.CREATE)).toBe(false);
    expect(peut(Modules.COMMANDES, Action.UPDATE)).toBe(false);
    expect(peut(Modules.COMMANDES, Action.UPDATE_FULL)).toBe(false);
    expect(peut(Modules.COMMANDES, Action.DELETE)).toBe(false);
    // Le reçu PDF emporte les coordonnées du client hors du backoffice.
    expect(peut(Modules.COMMANDES, Action.EXPORT)).toBe(false);
  });

  /**
   * Le tableau de bord porte le chiffre d'affaires du réseau, et les exports
   * de commandes en dépendent : un suivi de livraisons n'a pas à l'ouvrir.
   */
  it('n’a ni tableau de bord ni statistiques', () => {
    for (const action of actions) {
      expect([action, peut(Modules.DASHBOARD, action)]).toEqual([action, false]);
    }
  });

  it('n’a rien d’autre, nulle part', () => {
    // Trois droits, tous en LECTURE. Le reste du tableau doit rester vide.
    const lectures = new Set<Modules>([Modules.COMMANDES, Modules.LIVREURS, Modules.PLANNING]);
    for (const module of modules) {
      for (const action of actions) {
        const attendu = lectures.has(module) && action === Action.READ;
        expect([module, action, peut(module, action)]).toEqual([module, action, attendu]);
      }
    }
    expect(Object.keys(permissionsByRole[UserRole.LIVRAISON_OPS].modules)).toEqual([
      Modules.COMMANDES,
      Modules.LIVREURS,
      Modules.PLANNING,
    ]);
  });

  /**
   * Compte de SIÈGE : il voit les commandes de tous les restaurants. Le test
   * attrape l'ajout involontaire à STORE_ROLES, qui le limiterait en silence
   * à un point de vente et le priverait de la moitié des livraisons.
   */
  it('est un compte de siège, pas un compte de point de vente', () => {
    expect(isStoreRole(UserRole.LIVRAISON_OPS)).toBe(false);
    expect(resolveStaffType(UserRole.LIVRAISON_OPS)).toBe(UserType.BACKOFFICE);
  });
});


describe('droit PLANNING (conception du 24/10)', () => {
  const actions = Object.values(Action) as Action[];

  it('valeur partagée avec le backoffice', () => {
    expect(Modules.PLANNING).toBe('planning');
  });

  /**
   * Administrateur : tout. Manager et assistant : lecture, création,
   * modification et suppression, sur leur restaurant (le cloisonnement est
   * fait par le serveur). Call center (26/10) : les mêmes quatre gestes, sur
   * tous les restaurants (compte de siège). LIVRAISON_OPS : lecture. Les
   * autres : rien.
   */
  it('qui a quoi sur le planning', () => {
    const gestion = new Set<string>([Action.READ, Action.CREATE, Action.UPDATE, Action.DELETE]);
    const gestionnaires = new Set<UserRole>([UserRole.MANAGER, UserRole.ASSISTANT_MANAGER, UserRole.CALL_CENTER]);
    for (const role of Object.values(UserRole)) {
      for (const action of actions) {
        const attendu =
          role === UserRole.ADMIN ||
          (gestionnaires.has(role) && gestion.has(action)) ||
          (role === UserRole.LIVRAISON_OPS && action === Action.READ);
        expect([role, action, rolePeut(role, Modules.PLANNING, action)]).toEqual([role, action, attendu]);
      }
    }
  });

  it('le manager et l’assistant n’ont toujours ni courses ni livreurs', () => {
    for (const role of [UserRole.MANAGER, UserRole.ASSISTANT_MANAGER]) {
      for (const action of actions) {
        expect([role, action, rolePeut(role, Modules.LIVREURS, action)]).toEqual([role, action, false]);
      }
    }
  });

  it('ne change pas l’écran d’arrivée de LIVRAISON_OPS, du manager ni de l’assistant', () => {
    expect(Object.keys(permissionsByRole[UserRole.LIVRAISON_OPS].modules)[0]).toBe(Modules.COMMANDES);
    expect(Object.keys(permissionsByRole[UserRole.MANAGER].modules)[0]).toBe(Modules.DASHBOARD);
    expect(Object.keys(permissionsByRole[UserRole.ASSISTANT_MANAGER].modules)[0]).toBe(Modules.DASHBOARD);
  });
});

describe('call center : module Livraison (demandes du 26/10)', () => {
  const actions = Object.values(Action) as Action[];
  const peut = (module: Modules, action: Action) => rolePeut(UserRole.CALL_CENTER, module, action);

  /**
   * LIVREURS : lecture seulement, comme le suivi des livraisons. Ses gestes
   * sur une course passent par une liste de rôles (`ROLES_ACTIONS_COURSES`),
   * pas par ce droit : LIVREURS.UPDATE et DELETE disent la gestion des comptes
   * livreurs, qui reste à l'administrateur seul.
   */
  it('lit les courses et les livreurs, sans gérer les comptes livreurs', () => {
    for (const action of actions) {
      expect([action, peut(Modules.LIVREURS, action)]).toEqual([action, action === Action.READ]);
      expect([action, peut(Modules.LIVREURS, action)]).toEqual([
        action,
        rolePeut(UserRole.LIVRAISON_OPS, Modules.LIVREURS, action),
      ]);
    }
  });

  it('fait, envoie, change et supprime le planning, comme le manager mais pour tous les restaurants', () => {
    for (const action of actions) {
      expect([action, peut(Modules.PLANNING, action)]).toEqual([
        action,
        rolePeut(UserRole.MANAGER, Modules.PLANNING, action),
      ]);
    }
    expect(peut(Modules.PLANNING, Action.CREATE)).toBe(true);
    expect(peut(Modules.PLANNING, Action.UPDATE)).toBe(true);
    expect(peut(Modules.PLANNING, Action.DELETE)).toBe(true);
    expect(peut(Modules.PLANNING, Action.EXPORT)).toBe(false);
  });

  it('LIVRAISON_OPS reste en lecture seule sur la livraison', () => {
    for (const module of [Modules.LIVREURS, Modules.PLANNING]) {
      for (const action of actions) {
        expect([module, action, rolePeut(UserRole.LIVRAISON_OPS, module, action)]).toEqual([
          module,
          action,
          action === Action.READ,
        ]);
      }
    }
  });

  it('garde tout ce qu’il avait, et arrive toujours sur les Commandes', () => {
    expect(Object.keys(permissionsByRole[UserRole.CALL_CENTER].modules)).toEqual([
      Modules.COMMANDES,
      Modules.DASHBOARD,
      Modules.CLIENTS,
      Modules.MENUS,
      Modules.INVENTAIRE,
      Modules.PROMOTIONS,
      Modules.FIDELITE,
      Modules.CARD_NATION,
      Modules.COMMENTAIRES,
      Modules.MESSAGES,
      Modules.CALLS,
      Modules.BASE_DONNEES,
      Modules.CRM,
      Modules.LIVREURS,
      Modules.PLANNING,
    ]);
    expect(peut(Modules.COMMANDES, Action.UPDATE_FULL)).toBe(true);
    expect(peut(Modules.CALLS, Action.READ)).toBe(true);
  });

  it('est un compte de siège : il voit tous les restaurants', () => {
    expect(isStoreRole(UserRole.CALL_CENTER)).toBe(false);
    expect(resolveStaffType(UserRole.CALL_CENTER)).toBe(UserType.BACKOFFICE);
  });
});

describe('filtrerParDroit', () => {
  it('alertes de commande : tous les rôles sauf MARKETING lisent les commandes', () => {
    for (const role of Object.values(UserRole)) {
      expect([role, rolePeut(role, Modules.COMMANDES, Action.READ)]).toEqual([role, role !== UserRole.MARKETING]);
    }
  });

  it('retire seulement les comptes sans le droit, dans l’ordre reçu, sans copier les objets', () => {
    const comptes = Object.values(UserRole).map((role, i) => ({ id: `u${i}`, role }));
    const gardes = filtrerParDroit(comptes, Modules.COMMANDES, Action.READ);
    expect(gardes).toEqual(comptes.filter((c) => c.role !== UserRole.MARKETING));
    expect(gardes.every((c) => comptes.includes(c))).toBe(true);
  });

  it('rôle absent ou inconnu : écarté', () => {
    const comptes = [{ id: 'a', role: null }, { id: 'b' }, { id: 'c', role: 'INVENTE' }, { id: 'd', role: UserRole.ADMIN }];
    expect(filtrerParDroit(comptes, Modules.COMMANDES, Action.READ).map((c) => c.id)).toEqual(['d']);
  });
});
