/**
 * Module Livraison du backoffice, de bout en bout par HTTP (demandes du
 * 26/10).
 *
 * - Le call center lit TOUT le module (Carte live, Courses, Liste des
 *   livreurs, Planning, bandeau des restaurants, À traiter, fiches), comme le
 *   suivi des livraisons.
 * - Il AGIT sur les courses (forcer, annuler, relancer, Turbo, reprendre en
 *   interne) et sur le planning de tous les restaurants, comme
 *   l'administrateur (« oui le call center peut agir dans livraison »).
 * - La gestion des comptes livreurs et les réglages du planificateur restent
 *   à l'administrateur seul.
 * - Le suivi des livraisons (LIVRAISON_OPS) reste en lecture seule ; le
 *   manager et l'assistant gardent le planning de leur restaurant seulement.
 *
 * Les vrais contrôleurs, les vraies gardes de rôles et de droits, le vrai
 * routage de Nest (une route fixe prise pour un `:id` se verrait ici), la
 * vraie vérification du restaurant d'un planning et le vrai journal d'audit.
 * Seule l'authentification est simulée : l'en-tête `x-role` fait le compte
 * connecté, `x-restaurant` son restaurant.
 */
import { CanActivate, ExecutionContext, INestApplication, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { User, UserRole } from '@prisma/client';
import * as request from 'supertest';

import { AuditInterceptor } from 'src/modules/audit/audit.interceptor';
import { AuditService } from 'src/modules/audit/audit.service';
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
/** Restaurant du planning `ID`. */
const RESTO_PLAN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RESTO_AUTRE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

type Verbe = 'GET' | 'POST' | 'PATCH' | 'DELETE';
type Route = readonly [verbe: Verbe, chemin: string];

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

/** Gestes sur une course : administrateur et call center (26/10). */
const GESTES_COURSES: Route[] = [
  ['PATCH', `/courses/${ID}/force-assign`],
  ['PATCH', `/courses/${ID}/cancel`],
  ['PATCH', `/courses/${ID}/retry`],
  ['PATCH', `/courses/${ID}/relancer`],
  ['PATCH', `/courses/${ID}/turbo`],
  ['PATCH', `/courses/${ID}/interne`],
];

/**
 * Gestes sur le planning : administrateur et call center sur tous les
 * restaurants, manager et assistant sur le leur. `livreurs-ajoutables` est un
 * GET, mais il ne sert que le geste « Ajouter un livreur » : il suit les gestes.
 */
const GESTES_PLANNING: Route[] = [
  ['POST', '/schedule/plans/generate'],
  ['PATCH', `/schedule/plans/${ID}/send`],
  ['PATCH', `/schedule/plans/${ID}/confirm`],
  ['PATCH', `/schedule/plans/${ID}/archive`],
  ['DELETE', `/schedule/plans/${ID}`],
  ['PATCH', `/schedule/plans/${ID}/deliverers/${ID2}/day`],
  ['GET', `/schedule/plans/${ID}/livreurs-ajoutables`],
  ['POST', `/schedule/plans/${ID}/deliverers/${ID2}`],
  ['DELETE', `/schedule/plans/${ID}/deliverers/${ID2}`],
  ['POST', `/schedule/plans/${ID}/regenerate`],
];

const GESTES_CALL_CENTER: Route[] = [...GESTES_COURSES, ...GESTES_PLANNING];

/**
 * Administrateur seul : la gestion des comptes livreurs, et les réglages du
 * planificateur (lus par les Paramètres).
 */
const ADMIN_SEUL: Route[] = [
  ['PATCH', `/deliverers/${ID}/validate`],
  ['PATCH', `/deliverers/${ID}/reject`],
  ['PATCH', `/deliverers/${ID}/suspend`],
  ['PATCH', `/deliverers/${ID}/reactivate`],
  ['PATCH', `/deliverers/${ID}/force-activate`],
  ['PATCH', `/deliverers/${ID}/assign-restaurant`],
  ['DELETE', `/deliverers/${ID}`],
  ['GET', '/courses/planificateur/reglages'],
];

const TOUTES: Route[] = [...LECTURES, ...GESTES_CALL_CENTER, ...ADMIN_SEUL];

/** Corps envoyés, pour que chaque geste arrive jusqu'au service. */
const CORPS: Record<string, object> = {
  [`PATCH /courses/${ID}/force-assign`]: { deliverer_id: ID2 },
  [`PATCH /courses/${ID}/cancel`]: { reason: 'Client injoignable' },
  ['POST /schedule/plans/generate']: { restaurantId: RESTO_PLAN, periodStart: '2026-11-02', periodEnd: '2026-11-15' },
  [`PATCH /schedule/plans/${ID}/deliverers/${ID2}/day`]: { date: '2026-11-03', mode: 'REST' },
  [`POST /schedule/plans/${ID}/regenerate`]: { periodStart: '2026-11-02' },
};

/** Statut d'un geste qui passe : 201 pour un POST, 200 sinon (aucun `@HttpCode` sur ces routes). */
const succes = (verbe: Verbe) => (verbe === 'POST' ? 201 : 200);

const CONTROLEURS = [CourseAdminController, DeliverersAdminController, ScheduleAdminController, LivraisonTableauController];

/** Compte connecté d'après les en-têtes `x-role` et `x-restaurant`. */
class AuthentificationSimulee implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();
    const role = req.headers['x-role'] as UserRole;
    const restaurant_id = (req.headers['x-restaurant'] as string | undefined) ?? null;
    req.user = { id: `u-${role}`, role, type: resolveStaffType(role), restaurant_id, entity_status: 'ACTIVE' };
    return true;
  }
}

describe('module Livraison par HTTP : le call center lit tout et agit sur les courses et le planning', () => {
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
  };
  // Le planning `ID` est celui de RESTO_PLAN : la vraie méthode de lecture du
  // restaurant d'un planning, sur une base simulée.
  const basePlanning = {
    schedulePlan: { findUnique: jest.fn(async () => ({ id: ID, restaurant_id: RESTO_PLAN })) },
  };
  const planningLu = {
    apercu: jest.fn(async (_user: unknown, _restaurantId?: string) => []),
    listPlans: jest.fn(async () => []),
    lirePlanAccessible: jest.fn((id: string, user: User | undefined) =>
      ScheduleQueryService.prototype.lirePlanAccessible.call({ prisma: basePlanning }, id, user),
    ),
    getPlanDetail: jest.fn(async () => ({ id: ID })),
    countConfirmations: jest.fn(async () => ({})),
  };
  const gestes = {
    garde: {
      verifierAffectationForcee: jest.fn(async () => ({ renvoi: false })),
      cloreAutresOffres: jest.fn(async () => undefined),
    },
    offres: {
      offerToDeliverer: jest.fn(async () => true),
      offerNextDeliverer: jest.fn(async () => undefined),
      retryExpiredCourse: jest.fn(async () => undefined),
      relancerCourseAnnulee: jest.fn(async () => ({ ok: true, message: 'Course relancée', newCourseId: ID2 })),
      basculerVersTurbo: jest.fn(async () => ({ ok: true, message: 'Course confiée à Turbo' })),
      revenirEnInterne: jest.fn(async () => ({ ok: true, message: 'Course reprise en interne' })),
    },
    actions: { cancelCourse: jest.fn(async () => ({ id: ID })) },
    gateway: { livreurConnecte: jest.fn(async () => true) },
    appliLivreur: { regleActivePour: jest.fn(async () => false) },
    planning: {
      generatePlan: jest.fn(async () => ({ id: ID })),
      sendPlan: jest.fn(async () => ({ id: ID })),
      confirmPlan: jest.fn(async () => ({ id: ID })),
      archivePlan: jest.fn(async () => ({ id: ID })),
      deletePlan: jest.fn(async () => ({ success: true })),
      setDelivererDayMode: jest.fn(async () => ({ success: true })),
      livreursAjoutables: jest.fn(async () => []),
      addDelivererToPlan: jest.fn(async () => ({ success: true })),
      removeDelivererFromPlan: jest.fn(async () => ({ success: true })),
      regeneratePlan: jest.fn(async () => ({ id: ID2 })),
    },
  };
  const journal = { record: jest.fn() };
  // Services vides pour ce qui reste à l'administrateur : une garde qui
  // laisserait passer donnerait un 500, pas un 403.
  const vide = {} as Record<string, never>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: CONTROLEURS,
      providers: [
        { provide: TableauLivraisonService, useValue: lus.tableau },
        { provide: CourseQueryService, useValue: lus.courses },
        { provide: CourseActionService, useValue: gestes.actions },
        { provide: CourseOfferService, useValue: gestes.offres },
        { provide: GardeOffresService, useValue: gestes.garde },
        { provide: AppGateway, useValue: gestes.gateway },
        { provide: CourseSettingsHelper, useValue: vide },
        { provide: AppliLivreurService, useValue: gestes.appliLivreur },
        { provide: DeliverersService, useValue: lus.livreurs },
        { provide: DelivererInfoService, useValue: lus.infoLivreur },
        { provide: ScheduleQueryService, useValue: planningLu },
        { provide: SchedulePlanningService, useValue: gestes.planning },
        { provide: AuditService, useValue: journal },
        { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
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

  const appel = (role: UserRole, [verbe, chemin]: Route, options: { restaurant?: string; corps?: object } = {}) => {
    const r = request(app.getHttpServer());
    const req =
      verbe === 'GET' ? r.get(chemin) : verbe === 'POST' ? r.post(chemin) : verbe === 'PATCH' ? r.patch(chemin) : r.delete(chemin);
    req.set('x-role', role);
    if (options.restaurant) req.set('x-restaurant', options.restaurant);
    return req.send(options.corps ?? CORPS[`${verbe} ${chemin}`] ?? {});
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
    const classees = TOUTES.map(gabarit);
    expect(new Set(classees).size).toBe(classees.length);
    expect([...declarees].sort()).toEqual([...classees].sort());
  });

  describe('call center', () => {
    it.each(LECTURES)('%s %s : 200', async (verbe, chemin) => {
      const res = await appel(UserRole.CALL_CENTER, [verbe, chemin]);
      expect([verbe, chemin, res.status]).toEqual([verbe, chemin, 200]);
    });

    it.each(GESTES_CALL_CENTER)('%s %s : passe la garde et agit', async (verbe, chemin) => {
      const res = await appel(UserRole.CALL_CENTER, [verbe, chemin]);
      expect([verbe, chemin, res.status]).toEqual([verbe, chemin, succes(verbe)]);
    });

    it.each(ADMIN_SEUL)('%s %s : 403, reste à l’administrateur', async (verbe, chemin) => {
      const res = await appel(UserRole.CALL_CENTER, [verbe, chemin]);
      expect([verbe, chemin, res.status]).toEqual([verbe, chemin, 403]);
    });

    it('compte de siège : il lit le bandeau et le planning de tous les restaurants', async () => {
      lus.tableau.lire.mockClear();
      planningLu.apercu.mockClear();
      await appel(UserRole.CALL_CENTER, ['GET', '/livraison/tableau']).expect(200);
      await appel(UserRole.CALL_CENTER, ['GET', '/schedule/apercu']).expect(200);
      expect(lus.tableau.lire).toHaveBeenCalledWith(undefined);
      expect(planningLu.apercu.mock.calls[0][0]).toMatchObject({ role: UserRole.CALL_CENTER, type: 'BACKOFFICE' });
    });

    it('compte de siège : il génère et change le planning de n’importe quel restaurant', async () => {
      gestes.planning.generatePlan.mockClear();
      for (const restaurantId of [RESTO_PLAN, RESTO_AUTRE]) {
        await appel(UserRole.CALL_CENTER, ['POST', '/schedule/plans/generate'], {
          corps: { restaurantId, periodStart: '2026-11-02', periodEnd: '2026-11-15' },
        }).expect(201);
      }
      expect(gestes.planning.generatePlan.mock.calls.map((c: unknown[]) => (c[0] as { restaurantId: string }).restaurantId)).toEqual([
        RESTO_PLAN,
        RESTO_AUTRE,
      ]);
      gestes.planning.sendPlan.mockClear();
      await appel(UserRole.CALL_CENTER, ['PATCH', `/schedule/plans/${ID}/send`]).expect(200);
      expect(gestes.planning.sendPlan).toHaveBeenCalledWith(ID);
    });

    it('chaque geste est noté au journal d’audit à son nom, comme pour l’administrateur', async () => {
      for (const [verbe, chemin] of GESTES_CALL_CENTER.filter(([v]) => v !== 'GET')) {
        journal.record.mockClear();
        await appel(UserRole.CALL_CENTER, [verbe, chemin]).expect(succes(verbe));
        expect([verbe, chemin, journal.record.mock.calls.length]).toEqual([verbe, chemin, 1]);
        expect(journal.record.mock.calls[0][0]).toMatchObject({
          actor_id: `u-${UserRole.CALL_CENTER}`,
          actor_role: UserRole.CALL_CENTER,
          method: verbe,
          path: chemin,
          status_code: succes(verbe),
        });
      }
    });

    it('l’affectation forcée et l’annulation arrivent au service avec leur livreur et leur motif', async () => {
      gestes.offres.offerToDeliverer.mockClear();
      gestes.actions.cancelCourse.mockClear();
      await appel(UserRole.CALL_CENTER, ['PATCH', `/courses/${ID}/force-assign`]).expect(200);
      await appel(UserRole.CALL_CENTER, ['PATCH', `/courses/${ID}/cancel`]).expect(200);
      expect(gestes.offres.offerToDeliverer).toHaveBeenCalledWith(ID, ID2, false, true);
      expect(gestes.actions.cancelCourse).toHaveBeenCalledWith(ID, 'admin', { reason: 'Client injoignable' });
    });
  });

  describe('administrateur', () => {
    it.each(GESTES_CALL_CENTER)('%s %s : passe toujours', async (verbe, chemin) => {
      const res = await appel(UserRole.ADMIN, [verbe, chemin]);
      expect([verbe, chemin, res.status]).toEqual([verbe, chemin, succes(verbe)]);
    });
  });

  describe('suivi des livraisons (LIVRAISON_OPS) : lecture seule', () => {
    it.each(LECTURES)('%s %s : 200', async (verbe, chemin) => {
      const res = await appel(UserRole.LIVRAISON_OPS, [verbe, chemin]);
      expect([verbe, chemin, res.status]).toEqual([verbe, chemin, 200]);
    });

    it.each([...GESTES_CALL_CENTER, ...ADMIN_SEUL])('%s %s : 403', async (verbe, chemin) => {
      const res = await appel(UserRole.LIVRAISON_OPS, [verbe, chemin]);
      expect([verbe, chemin, res.status]).toEqual([verbe, chemin, 403]);
    });
  });

  describe.each([UserRole.MANAGER, UserRole.ASSISTANT_MANAGER])('%s : le planning de son restaurant seulement', (role) => {
    const routesDuPlan = [...GESTES_PLANNING, ...LECTURES].filter(([, chemin]) => chemin.startsWith(`/schedule/plans/${ID}`));

    it('les routes d’un planning : passe sur le sien, 403 sur un autre restaurant', async () => {
      expect(routesDuPlan.length).toBe(11);
      for (const [verbe, chemin] of routesDuPlan) {
        const sien = await appel(role, [verbe, chemin], { restaurant: RESTO_PLAN });
        expect([verbe, chemin, sien.status]).toEqual([verbe, chemin, succes(verbe)]);
        const autre = await appel(role, [verbe, chemin], { restaurant: RESTO_AUTRE });
        expect([verbe, chemin, autre.status]).toEqual([verbe, chemin, 403]);
      }
    });

    it('génère pour son restaurant, 403 pour un autre', async () => {
      const generer: Route = ['POST', '/schedule/plans/generate'];
      const corps = (restaurantId: string) => ({ restaurantId, periodStart: '2026-11-02', periodEnd: '2026-11-15' });
      await appel(role, generer, { restaurant: RESTO_PLAN, corps: corps(RESTO_PLAN) }).expect(201);
      await appel(role, generer, { restaurant: RESTO_PLAN, corps: corps(RESTO_AUTRE) }).expect(403);
    });

    it('ni courses, ni livreurs : 403 sur leurs lectures et leurs gestes', async () => {
      const horsPlanning = TOUTES.filter(([, chemin]) => chemin.startsWith('/courses') || chemin.startsWith('/deliverers'));
      for (const route of horsPlanning) {
        const res = await appel(role, route, { restaurant: RESTO_PLAN });
        expect([...route, res.status]).toEqual([...route, 403]);
      }
    });
  });

  it('un rôle sans le module (marketing, comptable, cuisine, caissier) : 403 partout', async () => {
    for (const role of [UserRole.MARKETING, UserRole.COMPTABLE, UserRole.CUISINE, UserRole.CAISSIER]) {
      // La caissière lit le bandeau de son restaurant (ligne Livreurs des
      // Commandes, `ROLES_TABLEAU_LIVRAISON`) : rien d'autre.
      const routes = role === UserRole.CAISSIER ? TOUTES.filter(([, chemin]) => chemin !== '/livraison/tableau') : TOUTES;
      for (const route of routes) {
        const res = await appel(role, route, { restaurant: RESTO_PLAN });
        expect([role, ...route, res.status]).toEqual([role, ...route, 403]);
      }
    }
  });
});
