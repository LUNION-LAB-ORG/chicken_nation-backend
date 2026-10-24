/**
 * POSITION IMPRÉCISE APRÈS LE RETRAIT (relecture du 24/10), de bout en bout :
 * `PATCH /deliverers/me/location` (vrai `DeliverersService.updateLocation`),
 * l'événement de position (vrai écouteur), puis la tâche de 10 s (vrai
 * planificateur), sur la base simulée.
 *
 * Avant : l'écouteur écartait le relevé de 150 m de précision, mais la
 * position était écrite sans sa précision ; au passage suivant, le
 * planificateur la prenait pour un départ : la commande ajoutée était
 * retirée au livreur qui attendait son sac, sa première livraison démarrée
 * au comptoir et la cloche « parti sans commande » sonnait.
 */
import { CourseStatut, DeliveryStatut, OrderStatus } from '@prisma/client';

import { DeliverersService } from 'src/modules/deliverers/services/deliverers.service';

import { course, livraison, livreur, RESTO } from './base-dispatch.simulee-spec';
import { apres, AU_COMPTOIR, avant, B, KM_LNG, MAINTENANT, monter, prete, RESTAURANT } from './banc-planificateur.simulee-spec';

jest.setTimeout(30_000);

beforeEach(() => {
  jest.useFakeTimers({ now: MAINTENANT, doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const aLEst = (metres: number) => ({ lat: RESTAURANT.lat, lng: RESTAURANT.lng + (metres / 1000) * KM_LNG });

/** D1 (nouvelle appli) a récupéré A il y a 60 s, encore au comptoir ; C ajoutée après le retrait, pas encore remise. */
function auComptoirApresRetrait() {
  const d1 = livreur({ ...AU_COMPTOIR, last_location_at: avant(90), last_available_at: null, protocole_appli: 3 });
  const a = prete({ status: OrderStatus.PICKED_UP, picked_up_at: avant(60) });
  const c = prete({ address: B, ready_at: avant(10) });
  const k = course({
    statut: CourseStatut.IN_DELIVERY,
    deliverer_id: d1.id,
    assigned_at: avant(400),
    at_restaurant_at: avant(300),
    picked_up_at: avant(60),
    created_at: avant(600),
  });
  const t = monter({
    commandes: [a, c],
    courses: [k],
    livraisons: [
      livraison({ course_id: k.id, order_id: a.id, sequence_order: 1 }),
      livraison({ course_id: k.id, order_id: c.id, sequence_order: 2, ajoutee_at: avant(10), ajoutee_apres_retrait: true }),
    ],
    livreurs: [d1],
  });
  const evenement = { locationUpdated: jest.fn() };
  const livreurs = new DeliverersService(
    t.base.prisma,
    {} as never,
    evenement as never,
    { load: jest.fn(async () => ({ gpsMaxSpeedKmh: 120 })) } as never,
    {} as never,
    {} as never,
  );
  /** L'appli envoie sa position (route), puis l'événement part vers l'écouteur, comme en vrai. */
  const envoie = async (metres: number, precision: number) => {
    await livreurs.updateLocation(d1.id, { ...aLEst(metres), accuracy: precision } as never);
    const charge = evenement.locationUpdated.mock.calls.at(-1)![0];
    await t.ecouteur.onPosition({ ...charge, restaurantId: RESTO });
  };
  return { d1, a, c, k, t, envoie };
}

describe('position imprécise après le retrait', () => {
  it('300 m à 150 m près : ni l’écouteur ni la tâche de 10 s ne font partir la course ; C reste à remettre', async () => {
    const s = auComptoirApresRetrait();
    jest.setSystemTime(apres(5));
    await s.envoie(300, 150);

    // La carte voit le relevé ; la dernière position précise (au comptoir) est gardée à côté.
    expect(s.d1.last_location).toMatchObject({ precision_m: 150, sure: { lat: RESTAURANT.lat, lng: RESTAURANT.lng } });
    expect(s.k.parti_at).toBeNull();

    jest.setSystemTime(apres(15));
    await s.t.passer();

    expect(s.k.parti_at).toBeNull();
    expect(s.t.livraisonsDe(s.k.id).map((l) => [l.order_id, l.statut])).toEqual([
      [s.a.id, DeliveryStatut.PENDING],
      [s.c.id, DeliveryStatut.PENDING],
    ]);
    expect(s.t.journalDe('COURSE_PARTIE')).toEqual([]);
    expect(s.t.push.notifyCommandeRetiree).not.toHaveBeenCalled();
    expect(s.t.cloche.sendCommandePasRemiseBell).not.toHaveBeenCalled();
  });

  it('la même position, précise : départ enregistré, C retirée de la course', async () => {
    const s = auComptoirApresRetrait();
    jest.setSystemTime(apres(5));
    await s.envoie(300, 12);

    expect(s.d1.last_location).toEqual({ ...aLEst(300), precision_m: 12 });
    expect(s.k.parti_at).toBeTruthy();
    expect(s.t.journalDe('COURSE_PARTIE')).toEqual([expect.objectContaining({ motif: 'POSITION' })]);
    expect(s.t.livraisonsDe(s.k.id).map((l) => l.order_id)).toEqual([s.a.id]);
  });
});
