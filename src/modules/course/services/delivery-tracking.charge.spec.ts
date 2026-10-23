/**
 * CHARGE DES POSITIONS (seconde passe du 23/10) : la nouvelle appli livreur
 * envoie une position toutes les 14 s même à l'arrêt, et une par minute hors
 * course. Chaque position passe par les écouteurs de
 * `deliverer:location:updated` ; aucun ne doit appeler Google à chaque fois.
 *
 *  - heure d'arrivée des clients (`DeliveryTrackingService`) : un calcul
 *    réussi sert 5 min ; un échec de Google (muet, lent, refus) est retenu
 *    1 min au lieu d'être retenté à chaque position ; un ajout à la tournée
 *    périme le calcul (le nouveau client avait son heure 5 min plus tard) ;
 *  - planificateur : une position au comptoir ne demande plus de passage
 *    (la tâche de 10 s décide), seule une position qui fait partir la course
 *    en demande un.
 */
import { DeliveryStatut } from '@prisma/client';

import { PlanificateurListener } from '../listeners/planificateur.listener';
import { DeliveryTrackingService } from './delivery-tracking.service';

const adresse = (lat: number, lng: number) => JSON.stringify({ latitude: lat, longitude: lng });

function suivi(getDirections: jest.Mock) {
  const livraisons: { statut: DeliveryStatut; order: { id: string; customer_id: string; address: string } }[] = [
    { statut: DeliveryStatut.IN_ROUTE, order: { id: 'o1', customer_id: 'c1', address: adresse(5.3, -3.95) } },
  ];
  // Même ligne pour les deux lectures du service (clients à prévenir, tournée à estimer).
  const prisma = { course: { findFirst: jest.fn(async () => ({ id: 'k1', deliveries: livraisons })) } };
  const emis: any[] = [];
  const gateway = { emitToUser: jest.fn((_id: string, _type: string, _ev: string, data: unknown) => emis.push(data)) };
  const service = new DeliveryTrackingService(prisma as never, gateway as never, { getDirections } as never, {} as never);
  const position = () =>
    service.onDelivererLocation({ delivererId: 'd1', lat: 5.29, lng: -3.97, heading: null, speedKmh: null, ts: new Date().toISOString() } as never);
  return { service, livraisons, emis, position };
}

const itineraire = (n: number) => ({
  legs: Array.from({ length: n }, () => ({ distanceMeters: 1000, durationSeconds: 300 })),
  stopsSeconds: (n - 1) * 120,
});

describe('heure d’arrivée des clients : jamais un appel Google à chaque position', () => {
  let maintenant = Date.parse('2026-10-23T12:00:00Z');
  beforeEach(() => {
    maintenant = Date.parse('2026-10-23T12:00:00Z');
    jest.spyOn(Date, 'now').mockImplementation(() => maintenant);
  });
  afterEach(() => jest.restoreAllMocks());

  it('Google muet : un seul essai par minute, la position part quand même au client', async () => {
    const getDirections = jest.fn(async () => null);
    const t = suivi(getDirections);
    for (let i = 0; i < 4; i++) {
      await t.position();
      maintenant += 14_000;
    }
    expect(getDirections).toHaveBeenCalledTimes(1);
    expect(t.emis).toHaveLength(4);
    expect(t.emis.every((e) => e.etaMin === null)).toBe(true);
    maintenant += 10_000; // 66 s après l'échec : nouvel essai
    await t.position();
    expect(getDirections).toHaveBeenCalledTimes(2);
  });

  it('Google en erreur (délai dépassé) : même chose, sans exception', async () => {
    const getDirections = jest.fn(async () => {
      throw new Error('délai dépassé');
    });
    const t = suivi(getDirections);
    await t.position();
    maintenant += 14_000;
    await t.position();
    expect(getDirections).toHaveBeenCalledTimes(1);
    expect(t.emis).toHaveLength(2);
  });

  it('calcul réussi : gardé 5 min ; un client ajouté à la tournée le refait tout de suite', async () => {
    const getDirections = jest.fn(async (p: { waypoints?: unknown[] }) => itineraire((p.waypoints?.length ?? 0) + 1));
    const t = suivi(getDirections);
    await t.position();
    maintenant += 14_000;
    await t.position();
    expect(getDirections).toHaveBeenCalledTimes(1);
    expect(t.emis[1].etaMin).toBe(5);

    t.livraisons.push({ statut: DeliveryStatut.PENDING, order: { id: 'o2', customer_id: 'c2', address: adresse(5.31, -3.94) } });
    maintenant += 14_000;
    await t.position();
    expect(getDirections).toHaveBeenCalledTimes(2);
    const o2 = t.emis.find((e) => e.orderId === 'o2');
    expect(o2?.etaMin).toBe(12); // 2 trajets de 5 min et l'arrêt chez o1
  });
});

describe('planificateur : une position au comptoir ne demande plus de passage', () => {
  function ecouteur(surPosition: jest.Mock) {
    const planificateur = { demander: jest.fn() };
    const l = new PlanificateurListener({} as never, planificateur as never, {} as never, {} as never, { surPosition } as never);
    return { l, planificateur };
  }
  const position = { delivererId: 'd1', lat: 5.286, lng: -3.9737, heading: null, speedKmh: null, ts: '', restaurantId: 'r1' };

  it('course récupérée encore au comptoir : rien (la tâche de 10 s décide)', async () => {
    const t = ecouteur(jest.fn(async () => ({ restaurant_id: 'r1', parti: false })));
    await t.l.onPosition(position as never);
    expect(t.planificateur.demander).not.toHaveBeenCalled();
  });

  it('position qui fait partir la course : passage demandé (commandes retirées à replanifier)', async () => {
    const t = ecouteur(jest.fn(async () => ({ restaurant_id: 'r1', parti: true })));
    await t.l.onPosition(position as never);
    expect(t.planificateur.demander).toHaveBeenCalledWith('r1', 'DEPART_POSITION');
  });

  it('livreur sans course au comptoir (une position par minute) : rien', async () => {
    const t = ecouteur(jest.fn(async () => null));
    await t.l.onPosition(position as never);
    expect(t.planificateur.demander).not.toHaveBeenCalled();
  });
});
