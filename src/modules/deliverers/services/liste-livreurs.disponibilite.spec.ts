/**
 * Liste des livreurs (`GET /deliverers`, fenêtre « Forcer l'affectation » du
 * backoffice) et carte (`GET /deliverers/live-locations`) : chaque livreur
 * porte `disponibilite`, calculée par la règle unique. Le backoffice montre
 * exactement ce que le serveur refuserait.
 */
import { CourseStatut } from '@prisma/client';

import {
  course,
  livreur,
  monterBaseDispatch,
  offre,
} from 'src/modules/course/services/base-dispatch.simulee-spec';

import { FIN_PAUSE_INDEFINIE } from '../helpers/disponibilite.rules';
import { DeliverersService } from './deliverers.service';

const MAINTENANT = new Date('2026-10-22T14:00:00.000Z');

beforeEach(() => {
  jest.useFakeTimers({ now: MAINTENANT, doNotFake: ['nextTick', 'setImmediate'] });
});
afterEach(() => jest.useRealTimers());

function monter() {
  const disponible = livreur({ first_name: 'Awa' });
  const enPause = livreur({ first_name: 'Koffi', pause_until: new Date('2026-10-22T14:32:00.000Z'), last_available_at: null });
  const horsService = livreur({ first_name: 'Yao', last_available_at: null });
  const enCourse = livreur({ first_name: 'Ama', last_available_at: null });
  const sollicite = livreur({ first_name: 'Kouamé' });
  const c = course();
  const base = monterBaseDispatch({
    livreurs: [disponible, enPause, horsService, enCourse, sollicite],
    courses: [c, course({ statut: CourseStatut.IN_DELIVERY, deliverer_id: enCourse.id })],
    offres: [offre({ course_id: c.id, deliverer_id: sollicite.id })],
  });
  const service = new DeliverersService(
    base.prisma,
    {} as never,
    {} as never,
    { load: jest.fn(async () => ({ gpsExpirationMinutes: 5 })) } as never,
    {} as never,
  );
  return { base, service, c, disponible, enPause, horsService, enCourse, sollicite };
}

describe('GET /deliverers : état de chaque livreur', () => {
  it('disponible, en pause jusqu’à 14 h 32, hors service, en course, offre en attente (avec sa course)', async () => {
    const t = monter();

    const { items } = await t.service.findAll({ limit: 50 } as never);
    const parPrenom = Object.fromEntries(items.map((l: any) => [l.first_name, l.disponibilite]));

    expect(parPrenom.Awa).toMatchObject({ etat: 'DISPONIBLE', libelle: 'Disponible', peut_recevoir_offre: true });
    expect(parPrenom.Koffi).toMatchObject({
      etat: 'EN_PAUSE',
      libelle: "En pause jusqu'à 14 h 32",
      message_refus: "Ce livreur est en pause jusqu'à 14 h 32.",
      peut_recevoir_offre: false,
    });
    expect(parPrenom.Yao).toMatchObject({ etat: 'HORS_SERVICE', libelle: 'Hors service', en_service: false });
    expect(parPrenom.Ama).toMatchObject({ etat: 'EN_COURSE', en_course: true });
    expect(parPrenom['Kouamé']).toMatchObject({
      etat: 'OFFRE_EN_ATTENTE',
      offre_en_attente: true,
      offre_course_id: t.c.id,
    });
    // Les champs de calcul ne sortent pas.
    expect(items.every((l: any) => !('_count' in l) && !('offer_attempts' in l))).toBe(true);
  });
});

describe('GET /deliverers/live-locations : « En pause » et « Hors service » visibles', () => {
  it('chaque livreur porte son état, position récente ou non (includeOffline)', async () => {
    const t = monter();
    t.horsService.pause_until = FIN_PAUSE_INDEFINIE;

    const carte = await t.service.getLiveLocations({ includeOffline: true });
    const parId = Object.fromEntries(carte.map((l) => [l.id, l.disponibilite]));

    expect(parId[t.enPause.id].libelle).toBe("En pause jusqu'à 14 h 32");
    expect(parId[t.horsService.id].libelle).toBe('En pause');
    expect(parId[t.disponible.id].etat).toBe('DISPONIBLE');
    expect(parId[t.sollicite.id].etat).toBe('OFFRE_EN_ATTENTE');
  });
});
