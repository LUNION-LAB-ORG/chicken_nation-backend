/**
 * Module Livraison du backoffice, de bout en bout par HTTP (demande du
 * 26/10) : le call center lit TOUT le module (Carte live, Courses, Liste des
 * livreurs, Planning, bandeau des restaurants, À traiter, fiches), comme le
 * suivi des livraisons, et reçoit 403 sur chaque geste d'écriture.
 *
 * Les vrais contrôleurs, les vraies gardes de rôles et de droits, le vrai
 * routage de Nest (une route fixe prise pour un `:id` se verrait ici). Seule
 * l'authentification est simulée : l'en-tête `x-role` fait le compte connecté.
 */
import { CanActivate, ExecutionContext, INestApplication, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { UserRole } from '@prisma/client';
import * as request from 'supertest';

import { LivraisonTableauController } from 'src/modules/course/controllers/livraison-tableau.controller';
import { CourseAdminController } from 'src/modules/course/controllers/course-admin.controller';
import { CourseSettingsHelper } from 'src/modules/course/helpers/course-settings.helper';
import { CourseActionService } from 'src/modules/course/services/course-action.service';
import { CourseOfferService } from 'src/modules/course/services/course-offer.service';
import { CourseQueryService } from 'src/modules/course/services/course-query.service';
import { GardeOffresService } from 'src/modules/course/services/garde-offres.service';
import { TableauLivraisonService } from 'src/modules/course/services/tableau-livraison.service';
import { DeliverersAdminController } from 'src/modules/deliverers/controllers/deliverers-admin.controller';
import { AppliLivreurService } from 'src/modules/deliverers/services/appli-livreur.service';
import { DelivererInfoService } from 'src/modules/deliverers/services/deliverer-info.service';
import { DeliverersService } from 'src/modules/deliverers/services/deliverers.service';
import { ScheduleAdminController } from 'src/modules/schedule/controllers/schedule-admin.controller';
import { SchedulePlanningService } from 'src/modules/schedule/services/schedule-planning.service';
import { ScheduleQueryService } from 'src/modules/schedule/services/schedule-query.service';
import { resolveStaffType } from 'src/modules/users/helpers/staff-type.helper';
import { AppGateway } from 'src/socket-io/gateways/app.gateway';

import { JwtAuthGuard } from './jwt-auth.guard';

const ID = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';

type Route = readonly [verbe: 'GET' | 'POST' | 'PATCH' | 'DELETE', chemin: string];

/** Ce que lisent les écrans du module Livraison. */
const LECTURES: Route[] = [
  ['GET', '/livraison/tableau'], // bandeau des restaurants, À traiter, À surveiller
  ['GET', '/courses'],
  ['GET', '/courses/stats'],
  ['GET', `/courses/${ID}`],
  ['GET', '/deliverers'],
  ['GET', '/deliverers/live-locations'], // Carte live, Livreurs « Aujourd'hui »
  ['GET', `/deliverers/${ID}`],
  ['GET', `/deliverers/${ID}/scoring-info`],
  ['GET', '/schedule/apercu'],
  ['GET', '/schedule/plans'],
  ['GET', `/schedule/plans/${ID}`],
  ['GET', `/schedule/plans/${ID}/stats`],
];

/** Chaque geste d'écriture du module. */
const ECRITURES: Route[] = [
  ['PATCH', `/courses/${ID}/force-assign`],
  ['PATCH', `/courses/${ID}/cancel`],
  ['PATCH', `/courses/${ID}/retry`],
  ['PATCH', `/courses/${ID}/relancer`],
  ['PATCH', `/courses/${ID}/turbo`],
  ['PATCH', `/courses/${ID}/interne`],
  ['PATCH', `/deliverers/${ID}/validate`],
  ['PATCH', `/deliverers/${ID}/reject`],
  ['PATCH', `/deliverers/${ID}/suspend`],
  ['PATCH', `/deliverers/${ID}/reactivate`],
  ['PATCH', `/deliverers/${ID}/force-activate`],
  ['PATCH', `/deliverers/${ID}/assign-restaurant`],
  ['DELETE', `/deliverers/${ID}`],
  ['POST', '/schedule/plans/generate'],
  ['PATCH', `/schedule/plans/${ID}/send`],
  ['PATCH', `/schedule/plans/${ID}/confirm`],
  ['PATCH', `/schedule/plans/${ID}/archive`],
  ['DELETE', `/schedule/plans/${ID}`],
  ['PATCH', `/schedule/plans/${ID}/deliverers/${ID2}/day`],
  ['POST', `/schedule/plans/${ID}/deliverers/${ID2}`],
  ['DELETE', `/schedule/plans/${ID}/deliverers/${ID2}`],
  ['POST', `/schedule/plans/${ID}/regenerate`],
];

/**
 * Lectures fermées au call center : les réglages du planificateur (lus par les
 * Paramètres, administrateur seul) et les livreurs qu'on peut ajouter à un
 * planning (elle ne sert que le geste « Ajouter un livreur »).
 */
const AUTRES_FERMEES: Route[] = [
  ['GET', '/courses/planificateur/reglages'],
  ['GET', `/schedule/plans/${ID}/livreurs-ajoutables`],
];

const CONTROLEURS = [CourseAdminController, DeliverersAdminController, ScheduleAdminController, LivraisonTableauController];

/** Compte connecté d'après l'en-tête `x-role` : compte de siège pour le call center. */
class AuthentificationSimulee implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const role = req.headers['x-role'] as UserRole;
    req.user = { id: `u-${role}`, role, type: resolveStaffType(role), restaurant_id: null, entity_status: 'ACTIVE' };
    return true;
  }
}

describe('module Livraison par HTTP : le call center lit tout, n’écrit rien', () => {
  let app: INestApplication;
  const lus = {
    tableau: { lire: jest.fn(async () => ({ genere_a: '', restaurants: [], signaux: [] })) },
    courses: {
      findAllAdmin: jest.fn(async () => ({ items: [], total: 0 })),
      getStats: jest.fn(async () => ({})),
      findOne: jest.fn(async () => ({ id: ID })),
    },
    livreurs: {
      findAll: jest.fn(async () => ({ items: [], total: 0 })),
      getLiveLocations: jest.fn(async () => []),
      findOne: jest.fn(async () => ({ id: ID })),
    },
    infoLivreur: { getScoringInfo: jest.fn(async () => ({})) },
    planning: {
      apercu: jest.fn(async (_user: unknown, _restaurantId?: string) => []),
      listPlans: jest.fn(async () => []),
      lirePlanAccessible: jest.fn(async () => ({ id: ID })),
      getPlanDetail: jest.fn(async () => ({ id: ID })),
      countConfirmations: jest.fn(async () => ({})),
    },
  };
  // Services d'écriture vides : une garde qui laisserait passer donnerait un 500, pas un 403.
  const ecritures = {} as Record<string, never>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: CONTROLEURS,
      providers: [
        { provide: TableauLivraisonService, useValue: lus.tableau },
        { provide: CourseQueryService, useValue: lus.courses },
        { provide: CourseActionService, useValue: ecritures },
        { provide: CourseOfferService, useValue: ecritures },
        { provide: GardeOffresService, useValue: ecritures },
        { provide: AppGateway, useValue: ecritures },
        { provide: CourseSettingsHelper, useValue: ecritures },
        { provide: AppliLivreurService, useValue: ecritures },
        { provide: DeliverersService, useValue: lus.livreurs },
        { provide: DelivererInfoService, useValue: lus.infoLivreur },
        { provide: ScheduleQueryService, useValue: lus.planning },
        { provide: SchedulePlanningService, useValue: ecritures },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useClass(AuthentificationSimulee)
      .compile();
    app = moduleRef.createNestApplication();
    await app.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    app.getHttpServer().closeAllConnections();
    await app.close();
  });

  const appel = (role: UserRole, [verbe, chemin]: Route) => {
    const r = request(app.getHttpServer());
    const req =
      verbe === 'GET' ? r.get(chemin) : verbe === 'POST' ? r.post(chemin) : verbe === 'PATCH' ? r.patch(chemin) : r.delete(chemin);
    return req.set('x-role', role).send({});
  };

  it('chaque route des quatre contrôleurs est classée ici : une route ajoutée doit l’être aussi', () => {
    const verbes: Record<number, string> = {
      [RequestMethod.GET]: 'GET',
      [RequestMethod.POST]: 'POST',
      [RequestMethod.PATCH]: 'PATCH',
      [RequestMethod.DELETE]: 'DELETE',
      [RequestMethod.PUT]: 'PUT',
    };
    const declarees: string[] = [];
    for (const controleur of CONTROLEURS) {
      const base = String(Reflect.getMetadata(PATH_METADATA, controleur));
      const proto = controleur.prototype as unknown as Record<string, object>;
      for (const m of Object.getOwnPropertyNames(proto)) {
        if (m === 'constructor' || typeof proto[m] !== 'function') continue;
        const chemin = Reflect.getMetadata(PATH_METADATA, proto[m]) as string | undefined;
        if (chemin === undefined) continue;
        const suffixe = chemin === '/' || chemin === '' ? '' : `/${chemin.replace(/^\//, '')}`;
        declarees.push(`${verbes[Reflect.getMetadata(METHOD_METADATA, proto[m]) as number]} /${base}${suffixe}`);
      }
    }
    const gabarit = ([verbe, chemin]: Route) =>
      `${verbe} ${chemin.replace(`/deliverers/${ID2}`, '/deliverers/:delivererId').replace(new RegExp(ID, 'g'), ':id')}`;
    const classees = [...LECTURES, ...ECRITURES, ...AUTRES_FERMEES].map(gabarit);
    expect([...declarees].sort()).toEqual([...classees].sort());
  });

  describe.each([UserRole.CALL_CENTER, UserRole.LIVRAISON_OPS])('%s', (role) => {
    it.each(LECTURES)('%s %s : 200', async (verbe, chemin) => {
      const res = await appel(role, [verbe, chemin]);
      expect([verbe, chemin, res.status]).toEqual([verbe, chemin, 200]);
    });

    it.each(ECRITURES)('%s %s : 403', async (verbe, chemin) => {
      const res = await appel(role, [verbe, chemin]);
      expect([verbe, chemin, res.status]).toEqual([verbe, chemin, 403]);
    });

    it.each(AUTRES_FERMEES)('%s %s : 403', async (verbe, chemin) => {
      const res = await appel(role, [verbe, chemin]);
      expect([verbe, chemin, res.status]).toEqual([verbe, chemin, 403]);
    });
  });

  it('le call center, compte de siège, lit le bandeau et le planning de tous les restaurants', async () => {
    lus.tableau.lire.mockClear();
    lus.planning.apercu.mockClear();
    await appel(UserRole.CALL_CENTER, ['GET', '/livraison/tableau']).expect(200);
    await appel(UserRole.CALL_CENTER, ['GET', '/schedule/apercu']).expect(200);
    expect(lus.tableau.lire).toHaveBeenCalledWith(undefined);
    expect(lus.planning.apercu.mock.calls[0][0]).toMatchObject({ role: UserRole.CALL_CENTER, type: 'BACKOFFICE' });
  });

  it('un rôle sans le module (marketing, comptable, cuisine) : 403 partout', async () => {
    for (const role of [UserRole.MARKETING, UserRole.COMPTABLE, UserRole.CUISINE]) {
      for (const route of [...LECTURES, ...ECRITURES, ...AUTRES_FERMEES]) {
        const res = await appel(role, route);
        expect([role, ...route, res.status]).toEqual([role, ...route, 403]);
      }
    }
  });
});
