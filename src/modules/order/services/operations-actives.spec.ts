/**
 * GET /orders/operations/active (conception du 24/10, 11.2) : ce que la liste
 * lit et ce qu'elle renvoie.
 *
 *  - ni `Order.recovery_code` ni `Delivery.delivery_pin` (le code que le
 *    client donne au livreur) : la liste part à tous les écrans du
 *    restaurant, aucun écran ne s'en sert ;
 *  - chaque course reçoit sa tournée et l'appli de son livreur ; ce qui a été
 *    lu pour les calculer (statut des livraisons, signe de vie, protocole)
 *    est retiré de la réponse ;
 *  - une seule lecture des réglages et une seule demande de présence pour
 *    toute la liste.
 */
import { finsSocketSimulees } from 'src/modules/deliverers/services/base-livreurs.simulee-spec';

import { OrderService } from './order.service';
import { SuiviOperationsService } from './suivi-operations.service';

const MAINTENANT = new Date('2026-10-24T12:30:00.000Z');

describe('findActiveForOperations : codes jamais lus', () => {
  async function requete(restaurantId?: string) {
    const findMany = jest.fn().mockResolvedValue([]);
    await OrderService.prototype.findActiveForOperations.call({ prisma: { order: { findMany } } }, restaurantId);
    return findMany.mock.calls[0][0];
  }

  it('omet le code de la commande et le code client de la livraison', async () => {
    const args = await requete('r1');
    expect(args.omit).toEqual({ recovery_code: true });
    expect(args.include.delivery.omit).toEqual({ delivery_pin: true });
    expect(args.where.restaurant_id).toBe('r1');
  });

  it('lit le statut des livraisons de la course et le signe de vie de l’appli du livreur', async () => {
    const { course } = (await requete()).include.delivery.include;
    expect(course.include.deliveries).toEqual({ select: { statut: true } });
    expect(course.include.deliverer.select).toMatchObject({ dernier_signal_at: true, protocole_appli: true });
    // Le code de retrait de la course (dit par le livreur à la caisse) reste lu : colonne de la course.
    expect(course.include.deliverer.select.delivery_pin).toBeUndefined();
  });
});

describe('SuiviOperationsService.enrichir', () => {
  const koffi = {
    id: 'liv-koffi',
    first_name: 'Koffi',
    last_name: 'Yao',
    phone: '+2250701020304',
    last_location: null,
    last_location_at: null,
    dernier_signal_at: new Date('2026-10-24T12:24:00.000Z'),
    protocole_appli: 4,
  };
  const courseK = {
    id: 'k',
    statut: 'IN_DELIVERY',
    pickup_code: '614',
    picked_up_at: new Date('2026-10-24T12:00:00.000Z'),
    parti_at: new Date('2026-10-24T12:05:00.000Z'),
    motif_depart: 'POSITION',
    estimated_duration_min: 15,
    delay_alerted_at: null,
    offer_attempts: [],
    deliverer: koffi,
    deliveries: [{ statut: 'DELIVERED' }, { statut: 'IN_ROUTE' }, { statut: 'PENDING' }],
  };
  const liste = () => [
    { id: 'o1', status: 'COLLECTED', restaurant: null, delivery: { id: 'l1', statut: 'DELIVERED', course: courseK } },
    { id: 'o2', status: 'PICKED_UP', restaurant: null, delivery: { id: 'l2', statut: 'IN_ROUTE', course: courseK } },
    { id: 'o3', status: 'READY', restaurant: null, delivery: null },
  ];

  function monter(
    reglages: Record<string, string> | Error = {},
    connectes: Set<string> | Error = new Set(),
    fins: Parameters<typeof finsSocketSimulees>[0] = {},
  ) {
    const settings = {
      getMany: reglages instanceof Error ? jest.fn().mockRejectedValue(reglages) : jest.fn().mockResolvedValue(reglages),
    };
    const gateway = {
      livreursConnectes: connectes instanceof Error ? jest.fn().mockRejectedValue(connectes) : jest.fn().mockResolvedValue(connectes),
    };
    const finsSocket = finsSocketSimulees(fins);
    return {
      service: new SuiviOperationsService(settings as never, gateway as never, finsSocket as never),
      settings,
      gateway,
      fins: finsSocket,
    };
  }

  it('tournée et appli sur chaque course, une lecture des réglages, une demande de présence pour toute la liste', async () => {
    const { service, settings, gateway } = monter({ 'course.delay_alert_factor': '1.5', 'deliverer.appli_fermee_apres_s': '180' });
    const [a, b, c] = (await service.enrichir(liste(), MAINTENANT)) as any[];

    expect(settings.getMany).toHaveBeenCalledTimes(1);
    expect(gateway.livreursConnectes).toHaveBeenCalledTimes(1);
    expect(gateway.livreursConnectes).toHaveBeenCalledWith(['liv-koffi']);

    // Retrait 12:00, 15 min × 1,5 dépassées à 12:30 ; fin prévue 12:20 : 10 min de retard.
    expect(a.delivery.course.tournee).toEqual({
      total: 3,
      livrees: 1,
      fin_prevue: '2026-10-24T12:20:00.000Z',
      en_retard: true,
      retard_min: 10,
    });
    expect(b.delivery.course.tournee).toEqual(a.delivery.course.tournee);
    expect(a.delivery.course.deliverer).toEqual({
      id: 'liv-koffi',
      first_name: 'Koffi',
      last_name: 'Yao',
      phone: '+2250701020304',
      last_location: null,
      last_location_at: null,
      appli_active: false,
      appli_vue_a: '2026-10-24T12:24:00.000Z',
      appli_connectee: false,
      // Aucune fin de socket gardée : aucune preuve de fermeture, connexion coupée.
      appli_etat: 'COUPURE',
    });
    expect(a.delivery.course).not.toHaveProperty('deliveries');
    expect(a.delivery.course.pickup_code).toBe('614');
    // Sans livraison : inchangée, avec `sac_a_rapporter` nul (28/10).
    expect(c).toEqual({ ...liste()[2], sac_a_rapporter: null });
  });

  it('écran Commandes (25/10) : « Appli fermée » seulement sur la fin du socket par l’appli, lue une fois pour la liste', async () => {
    const fermee = monter({}, new Set(), { 'liv-koffi': { raison: 'client namespace disconnect', a: new Date('2026-10-24T12:24:05.000Z') } });
    const [a] = (await fermee.service.enrichir(liste(), MAINTENANT)) as any[];
    expect(a.delivery.course.deliverer).toMatchObject({ appli_active: false, appli_etat: 'FERMEE' });
    expect(fermee.fins.lireSansSocket).toHaveBeenCalledTimes(1);

    const coupee = monter({}, new Set(), { 'liv-koffi': { raison: 'ping timeout', a: new Date('2026-10-24T12:24:50.000Z') } });
    const [b] = (await coupee.service.enrichir(liste(), MAINTENANT)) as any[];
    expect(b.delivery.course.deliverer).toMatchObject({ appli_active: false, appli_etat: 'COUPURE' });

    // Redis des fins muet : jamais FERMEE.
    const muet = monter({}, new Set(), null);
    const [c] = (await muet.service.enrichir(liste(), MAINTENANT)) as any[];
    expect(c.delivery.course.deliverer).toMatchObject({ appli_etat: 'COUPURE' });
  });

  it('aucun livreur dans la liste : aucune demande de présence', async () => {
    const { service, gateway, fins } = monter();
    await service.enrichir([{ id: 'o3', delivery: null }], MAINTENANT);
    expect(gateway.livreursConnectes).not.toHaveBeenCalled();
    expect(fins.lire).not.toHaveBeenCalled();
  });

  it('réglages et présence illisibles : valeurs par défaut, présence inconnue, la liste part quand même', async () => {
    const { service } = monter(new Error('base indisponible'), new Error('Redis muet'));
    const [a] = (await service.enrichir(liste(), MAINTENANT)) as any[];
    expect(a.delivery.course.tournee.en_retard).toBe(true);
    expect(a.delivery.course.deliverer).toMatchObject({ appli_active: false, appli_connectee: null });
  });
});
