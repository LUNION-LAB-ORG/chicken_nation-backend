import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { UserRolesGuard } from './user-roles.guard';
import { CourseAdminController } from 'src/modules/course/controllers/course-admin.controller';
import { DeliverersAdminController } from 'src/modules/deliverers/controllers/deliverers-admin.controller';

/**
 * Les écrans Courses et Livreurs ne sont PAS gardés par une permission mais
 * par une liste de rôles, posée sur la classe. Ouvrir leurs lectures à
 * LIVRAISON_OPS, puis au call center (26/10), et les gestes sur une course au
 * call center (26/10, `ROLES_ACTIONS_COURSES`), repose donc entièrement sur le
 * fait que le garde fait primer la méthode sur la classe.
 *
 * Le planning est sorti de cette liste le 24/10 : il est gardé par le droit
 * `Modules.PLANNING` (voir `schedule-admin.droits.spec.ts`).
 *
 * Ce test rejoue le VRAI garde sur les VRAIES méthodes des contrôleurs : si
 * quelqu'un déplace un décorateur, ou si NestJS changeait cette précédence,
 * l'écran s'ouvrirait en écriture à un rôle censé ne rien pouvoir faire.
 */
function passe(controleur: object, methode: string, role: UserRole): boolean {
  const garde = new UserRolesGuard(new Reflector());
  const contexte = {
    getHandler: () => (controleur as Record<string, unknown>)[methode],
    getClass: () => controleur.constructor,
    switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
  } as never;
  return garde.canActivate(contexte);
}

/**
 * `lectures` : ouvertes au suivi des livraisons et au call center.
 * `gestesCallCenter` : gestes sur une course, ouverts au call center (26/10).
 * `actions` : gestion des comptes livreurs, administrateur seul.
 * `reservees` : lectures qui ne servent pas les écrans du module Livraison
 * (réglages du planificateur, lus par les Paramètres) : administrateur seul.
 */
const ECRANS: {
  nom: string;
  proto: object;
  lectures: string[];
  gestesCallCenter: string[];
  actions: string[];
  reservees: string[];
}[] = [
  {
    nom: 'Courses',
    proto: CourseAdminController.prototype,
    lectures: ['findAll', 'stats', 'findOne'],
    gestesCallCenter: [
      'forceAssign',
      'cancel',
      'retry',
      'relancerCourseAnnulee',
      'basculerVersTurbo',
      'revenirEnInterne',
      'relancerLivraisonCommande',
    ],
    actions: [],
    reservees: ['reglagesPlanificateur'],
  },
  {
    nom: 'Livreurs',
    proto: DeliverersAdminController.prototype,
    lectures: ['findAll', 'getLiveLocations', 'findOne', 'getScoringInfo'],
    gestesCallCenter: [],
    actions: ['validate', 'reject', 'suspend', 'reactivate', 'forceActivate', 'assignRestaurant', 'remove'],
    reservees: [],
  },
];

/** Rôles qui consultent le module Livraison. */
const LECTEURS: UserRole[] = [UserRole.LIVRAISON_OPS, UserRole.CALL_CENTER];

describe('suivi des livraisons : LIVRAISON_OPS lit, le call center lit et agit sur les courses', () => {
  for (const ecran of ECRANS) {
    describe(ecran.nom, () => {
      const toutes = [...ecran.lectures, ...ecran.gestesCallCenter, ...ecran.actions, ...ecran.reservees];

      it('les méthodes nommées ici existent vraiment', () => {
        for (const m of toutes) {
          expect([ecran.nom, m, typeof (ecran.proto as Record<string, unknown>)[m]]).toEqual([
            ecran.nom,
            m,
            'function',
          ]);
        }
      });

      it('chaque méthode du contrôleur est nommée ici : une route ajoutée doit être classée', () => {
        const proto = ecran.proto as Record<string, unknown>;
        const methodes = Object.getOwnPropertyNames(proto).filter(
          (m) => m !== 'constructor' && typeof proto[m] === 'function',
        );
        expect(methodes.sort()).toEqual([...toutes].sort());
      });

      it.each(LECTEURS)('ouvre ses lectures à %s', (role) => {
        for (const m of ecran.lectures) {
          expect([m, passe(ecran.proto, m, role)]).toEqual([m, true]);
        }
      });

      it('ferme TOUS ses gestes au suivi des livraisons', () => {
        for (const m of [...ecran.gestesCallCenter, ...ecran.actions, ...ecran.reservees]) {
          expect([m, passe(ecran.proto, m, UserRole.LIVRAISON_OPS)]).toEqual([m, false]);
        }
      });

      it('ouvre au call center les gestes sur une course, et rien de plus', () => {
        for (const m of ecran.gestesCallCenter) {
          expect([m, passe(ecran.proto, m, UserRole.CALL_CENTER)]).toEqual([m, true]);
        }
        for (const m of [...ecran.actions, ...ecran.reservees]) {
          expect([m, passe(ecran.proto, m, UserRole.CALL_CENTER)]).toEqual([m, false]);
        }
      });

      it('laisse l’administrateur tout faire', () => {
        for (const m of toutes) {
          expect([m, passe(ecran.proto, m, UserRole.ADMIN)]).toEqual([m, true]);
        }
      });

      it('n’ouvre rien aux autres rôles', () => {
        const autres = Object.values(UserRole).filter(
          (r) => r !== UserRole.ADMIN && !LECTEURS.includes(r),
        );
        expect(autres.length).toBeGreaterThan(0);
        for (const role of autres) {
          for (const m of toutes) {
            expect([role, m, passe(ecran.proto, m, role)]).toEqual([role, m, false]);
          }
        }
      });
    });
  }
});
