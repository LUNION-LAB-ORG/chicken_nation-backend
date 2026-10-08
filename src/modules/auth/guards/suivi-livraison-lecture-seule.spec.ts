import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { UserRolesGuard } from './user-roles.guard';
import { CourseAdminController } from 'src/modules/course/controllers/course-admin.controller';
import { DeliverersAdminController } from 'src/modules/deliverers/controllers/deliverers-admin.controller';
import { ScheduleAdminController } from 'src/modules/schedule/controllers/schedule-admin.controller';

/**
 * Les écrans Courses, Livreurs et Planning ne sont PAS gardés par une
 * permission mais par une liste de rôles, posée sur la classe. Ouvrir leurs
 * lectures à LIVRAISON_OPS repose donc entièrement sur le fait que le garde
 * fait primer la méthode sur la classe.
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

const ECRANS: { nom: string; proto: object; lectures: string[]; actions: string[] }[] = [
  {
    nom: 'Courses',
    proto: CourseAdminController.prototype,
    lectures: ['findAll', 'stats', 'findOne'],
    actions: ['forceAssign', 'cancel', 'retry', 'relancerCourseAnnulee', 'basculerVersTurbo', 'revenirEnInterne'],
  },
  {
    nom: 'Livreurs',
    proto: DeliverersAdminController.prototype,
    lectures: ['findAll', 'getLiveLocations', 'findOne', 'getScoringInfo'],
    actions: ['validate', 'reject', 'suspend', 'reactivate', 'forceActivate', 'assignRestaurant', 'remove'],
  },
  {
    nom: 'Planning',
    proto: ScheduleAdminController.prototype,
    lectures: ['listPlans', 'getPlanDetail', 'getPlanStats'],
    actions: ['generatePlan', 'sendPlan', 'confirmPlan', 'archivePlan', 'deletePlan', 'setDelivererDay', 'addDeliverer', 'regeneratePlan'],
  },
];

describe('suivi des livraisons : LIVRAISON_OPS lit, et rien de plus', () => {
  for (const ecran of ECRANS) {
    describe(ecran.nom, () => {
      it('les méthodes nommées ici existent vraiment', () => {
        for (const m of [...ecran.lectures, ...ecran.actions]) {
          expect([ecran.nom, m, typeof (ecran.proto as Record<string, unknown>)[m]]).toEqual([
            ecran.nom,
            m,
            'function',
          ]);
        }
      });

      it('ouvre ses lectures à LIVRAISON_OPS', () => {
        for (const m of ecran.lectures) {
          expect([m, passe(ecran.proto, m, UserRole.LIVRAISON_OPS)]).toEqual([m, true]);
        }
      });

      it('lui ferme TOUTES ses actions', () => {
        for (const m of ecran.actions) {
          expect([m, passe(ecran.proto, m, UserRole.LIVRAISON_OPS)]).toEqual([m, false]);
        }
      });

      it('laisse l’administrateur tout faire', () => {
        for (const m of [...ecran.lectures, ...ecran.actions]) {
          expect([m, passe(ecran.proto, m, UserRole.ADMIN)]).toEqual([m, true]);
        }
      });

      it('n’ouvre rien aux autres rôles', () => {
        const autres = Object.values(UserRole).filter(
          (r) => r !== UserRole.ADMIN && r !== UserRole.LIVRAISON_OPS,
        );
        for (const role of autres) {
          for (const m of [...ecran.lectures, ...ecran.actions]) {
            expect([role, m, passe(ecran.proto, m, role)]).toEqual([role, m, false]);
          }
        }
      });
    });
  }
});
