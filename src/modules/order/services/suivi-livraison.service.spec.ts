import { NotFoundException } from '@nestjs/common';
import { EntityStatus } from '@prisma/client';

import { PANIER_ANNULE_PAR_CLIENT_WHERE } from '../helpers/brouillons.rules';
import { CommandeSuiviLivraison, SuiviLivraisonService } from './suivi-livraison.service';

const UUID = '11111111-1111-4111-8111-111111111111';

function monter(
  commande: unknown,
  reglages: Record<string, string> | Error = {},
  connectes: Set<string> | null | Error = new Set<string>(),
) {
  const prisma = { order: { findFirst: jest.fn().mockResolvedValue(commande) } };
  const settings = {
    getMany: reglages instanceof Error ? jest.fn().mockRejectedValue(reglages) : jest.fn().mockResolvedValue(reglages),
  };
  const gateway = {
    livreursConnectes: connectes instanceof Error ? jest.fn().mockRejectedValue(connectes) : jest.fn().mockResolvedValue(connectes),
  };
  return {
    service: new SuiviLivraisonService(prisma as never, settings as never, gateway as never),
    prisma,
    settings,
    gateway,
  };
}

/** Commande récupérée à 12:18, livreur encore au comptoir. */
const AU_COMPTOIR = {
  id: UUID,
  restaurant_id: 'r1',
  type: 'DELIVERY',
  status: 'PICKED_UP',
  delivery_service: 'CHICKEN_NATION',
  ready_at: new Date('2026-10-24T12:00:00.000Z'),
  picked_up_at: new Date('2026-10-24T12:18:00.000Z'),
  collected_at: null,
  restaurant: { latitude: 5.286, longitude: -3.9737 },
  delivery: {
    id: 'liv-a',
    statut: 'PENDING',
    arrived_at: null,
    delivered_at: null,
    turbo_courier_id: null,
    turbo_courier_name: null,
    turbo_courier_phone: null,
    course: {
      id: 'crs-1',
      reference: 'CRS-261024-00001',
      pickup_code: '614',
      statut: 'IN_DELIVERY',
      assigned_at: new Date('2026-10-24T12:02:00.000Z'),
      at_restaurant_at: new Date('2026-10-24T12:08:00.000Z'),
      picked_up_at: new Date('2026-10-24T12:18:00.000Z'),
      parti_at: null,
      motif_depart: null,
      estimated_duration_min: null,
      retenue_jusqua: null,
      deliverer: { id: 'liv-koffi', first_name: 'Koffi', last_name: 'Kouassi', phone: '+2250701020304', last_location: null, last_location_at: null },
      offer_attempts: [],
      deliveries: [{ id: 'liv-a', statut: 'PENDING', sequence_order: 1, order: { status: 'PICKED_UP' } }],
    },
  },
} as unknown as CommandeSuiviLivraison;

const MAINTENANT = new Date('2026-10-24T12:20:00.000Z');
const departPrevu = (r: { etapes: { cle: string; prevue: string | null }[] }) => r.etapes.find((e) => e.cle === 'depart')?.prevue;

describe('SuiviLivraisonService.lire', () => {
  it('commande non supprimée, par identifiant ou par référence', async () => {
    const { service, prisma } = monter(AU_COMPTOIR);
    await service.lire(UUID);
    expect(prisma.order.findFirst.mock.calls[0][0].where).toEqual({ id: UUID, entity_status: { not: EntityStatus.DELETED } });
    await service.lire('ORD-261024-34769');
    expect(prisma.order.findFirst.mock.calls[1][0].where).toEqual({
      reference: 'ORD-261024-34769',
      entity_status: { not: EntityStatus.DELETED },
    });
  });

  it('panier annulé par le client rendu seulement sur demande, comme le détail', async () => {
    const { service, prisma } = monter(AU_COMPTOIR);
    await service.lire(UUID, { inclurePanierAnnuleParClient: true });
    expect(prisma.order.findFirst.mock.calls[0][0].where).toEqual({
      AND: [{ id: UUID }, { OR: [{ entity_status: { not: EntityStatus.DELETED } }, PANIER_ANNULE_PAR_CLIENT_WHERE] }],
    });
  });

  it('introuvable : 404', async () => {
    const { service } = monter(null);
    await expect(service.lire(UUID)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('ne lit jamais la clé Turbo du restaurant ni le code client de la livraison', async () => {
    const { service, prisma } = monter(AU_COMPTOIR);
    await service.lire(UUID);
    const { select } = prisma.order.findFirst.mock.calls[0][0];
    expect(select.restaurant).toEqual({ select: { latitude: true, longitude: true } });
    expect(select.delivery.select.delivery_pin).toBeUndefined();
  });
});

describe('SuiviLivraisonService.suivi', () => {
  it('course récupérée, pas partie : relit les réglages pour la fin de la fenêtre', async () => {
    const { service, settings } = monter(AU_COMPTOIR, { 'course.ajout_apres_retrait_max_s': '300' });
    const r = await service.suivi(AU_COMPTOIR, MAINTENANT);
    expect(settings.getMany).toHaveBeenCalledTimes(1);
    expect(departPrevu(r)).toBe('2026-10-24T12:23:00.000Z');
  });

  it('ajout après le retrait coupé au réglage : aucun départ prévu', async () => {
    const { service } = monter(AU_COMPTOIR, { 'course.ajout_apres_retrait': 'false' });
    const r = await service.suivi(AU_COMPTOIR, MAINTENANT);
    expect(r.etapes.some((e) => e.cle === 'depart')).toBe(false);
  });

  it('réglages illisibles : valeurs par défaut, jamais d’erreur', async () => {
    const { service } = monter(AU_COMPTOIR, new Error('base indisponible'));
    const r = await service.suivi(AU_COMPTOIR, MAINTENANT);
    expect(departPrevu(r)).toBe('2026-10-24T12:22:00.000Z');
  });

  it('course terminée ou commande sans course : aucune lecture des réglages ni de la présence', async () => {
    const terminee = {
      ...AU_COMPTOIR,
      delivery: { ...AU_COMPTOIR.delivery!, course: { ...AU_COMPTOIR.delivery!.course!, statut: 'COMPLETED' } },
    } as CommandeSuiviLivraison;
    const sansCourse = { ...AU_COMPTOIR, delivery: null } as CommandeSuiviLivraison;
    for (const commande of [terminee, sansCourse]) {
      const { service, settings, gateway } = monter(commande);
      const r = await service.suivi(commande, MAINTENANT);
      expect(settings.getMany).not.toHaveBeenCalled();
      expect(gateway.livreursConnectes).not.toHaveBeenCalled();
      expect(r.livreur ?? {}).not.toHaveProperty('appli_active');
    }
  });

  it('course partie : une lecture (facteur de retard, seuil de l’appli), présence du seul livreur de la course', async () => {
    const partie = {
      ...AU_COMPTOIR,
      delivery: {
        ...AU_COMPTOIR.delivery!,
        course: {
          ...AU_COMPTOIR.delivery!.course!,
          picked_up_at: new Date('2026-10-24T11:40:00.000Z'),
          parti_at: new Date('2026-10-24T11:45:00.000Z'),
          motif_depart: 'POSITION',
          estimated_duration_min: 10,
          deliverer: {
            ...AU_COMPTOIR.delivery!.course!.deliverer!,
            protocole_appli: 4,
            dernier_signal_at: new Date('2026-10-24T12:10:00.000Z'),
          },
        },
      },
    } as CommandeSuiviLivraison;
    const { service, settings, gateway } = monter(partie, {
      'course.delay_alert_factor': '2',
      'deliverer.appli_fermee_apres_s': '300',
    });
    const r = await service.suivi(partie, MAINTENANT);
    expect(settings.getMany).toHaveBeenCalledTimes(1);
    expect(settings.getMany.mock.calls[0][0]).toEqual(
      expect.arrayContaining(['course.delay_alert_factor', 'deliverer.appli_fermee_apres_s']),
    );
    expect(gateway.livreursConnectes).toHaveBeenCalledWith(['liv-koffi']);
    // Retrait 11:40, 10 min × 2 = 20 min dépassées à 12:20 : fin prévue 11:55, 25 min de retard.
    expect(r.course).toMatchObject({ fin_prevue: '2026-10-24T11:55:00.000Z', en_retard: true, retard_min: 25 });
    // Vu il y a 10 min, sans socket, seuil 300 s : appli fermée.
    expect(r.livreur).toMatchObject({ appli_active: false, appli_vue_a: '2026-10-24T12:10:00.000Z', appli_connectee: false });
  });

  it('présence illisible ou réglages illisibles : valeurs par défaut, présence inconnue, jamais d’erreur', async () => {
    const { service } = monter(AU_COMPTOIR, new Error('base indisponible'), new Error('Redis muet'));
    const r = await service.suivi(AU_COMPTOIR, MAINTENANT);
    expect(r.livreur).toMatchObject({ appli_connectee: null });
    expect(r.course).toMatchObject({ en_retard: false });
  });
});
