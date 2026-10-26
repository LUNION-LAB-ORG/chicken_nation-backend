import { NotFoundException } from '@nestjs/common';
import { EntityStatus } from '@prisma/client';

import { finsSocketSimulees } from 'src/modules/deliverers/services/base-livreurs.simulee-spec';

import { PANIER_ANNULE_PAR_CLIENT_WHERE } from '../helpers/brouillons.rules';
import { CommandeSuiviLivraison, SuiviLivraisonService } from './suivi-livraison.service';

const UUID = '11111111-1111-4111-8111-111111111111';

function monter(
  commande: unknown,
  reglages: Record<string, string> | Error = {},
  connectes: Set<string> | null | Error = new Set<string>(),
  fins: Parameters<typeof finsSocketSimulees>[0] = {},
) {
  const prisma = { order: { findFirst: jest.fn().mockResolvedValue(commande) } };
  const settings = {
    getMany: reglages instanceof Error ? jest.fn().mockRejectedValue(reglages) : jest.fn().mockResolvedValue(reglages),
  };
  const gateway = {
    livreursConnectes: connectes instanceof Error ? jest.fn().mockRejectedValue(connectes) : jest.fn().mockResolvedValue(connectes),
  };
  const finsSocket = finsSocketSimulees(fins);
  return {
    service: new SuiviLivraisonService(prisma as never, settings as never, gateway as never, finsSocket as never),
    prisma,
    settings,
    gateway,
    fins: finsSocket,
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
      const { service, settings, gateway, fins } = monter(commande);
      const r = await service.suivi(commande, MAINTENANT);
      expect(settings.getMany).not.toHaveBeenCalled();
      expect(gateway.livreursConnectes).not.toHaveBeenCalled();
      expect(fins.lire).not.toHaveBeenCalled();
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
    // Vu il y a 10 min, sans socket, seuil 300 s, aucune fin de socket gardée : connexion coupée.
    expect(r.livreur).toMatchObject({
      appli_active: false,
      appli_vue_a: '2026-10-24T12:10:00.000Z',
      appli_connectee: false,
      appli_etat: 'COUPURE',
    });

    // Tiroir (25/10) : l'appli a fermé elle-même son socket, rien ensuite : « Appli fermée ».
    const fermee = monter(partie, { 'deliverer.appli_fermee_apres_s': '300' }, new Set(), {
      'liv-koffi': { raison: 'client namespace disconnect', a: new Date('2026-10-24T12:10:10.000Z') },
    });
    const f = await fermee.service.suivi(partie, MAINTENANT);
    expect(fermee.fins.lireSansSocket).toHaveBeenCalledWith(['liv-koffi'], new Set());
    expect(f.livreur).toMatchObject({ appli_active: false, appli_etat: 'FERMEE' });
  });

  it('présence illisible ou réglages illisibles : valeurs par défaut, présence inconnue, jamais d’erreur', async () => {
    const { service } = monter(AU_COMPTOIR, new Error('base indisponible'), new Error('Redis muet'));
    const r = await service.suivi(AU_COMPTOIR, MAINTENANT);
    expect(r.livreur).toMatchObject({ appli_connectee: null });
    expect(r.course).toMatchObject({ en_retard: false });
  });
});

describe('SuiviLivraisonService.codeClient (code de retrait du client, 26/10)', () => {
  const COMMANDE = { id: UUID, restaurant_id: 'r1' };
  const AGENT = { id: 'agent-1', role: 'CALL_CENTER', fullname: 'Awa Koné', email: 'awa@cn.ci' } as never;
  const ADMIN = { id: 'admin-1', role: 'ADMIN', fullname: 'Admin', email: 'admin@cn.ci' } as never;
  const T0 = new Date('2026-10-26T10:00:00.000Z');
  const plus = (ms: number) => new Date(T0.getTime() + ms);

  function monterCode(lue: unknown, avecJournal = true) {
    const prisma = { order: { findUnique: jest.fn().mockResolvedValue(lue) } };
    const audit = { record: jest.fn() };
    const service = new SuiviLivraisonService(
      prisma as never,
      {} as never,
      undefined,
      undefined,
      avecJournal ? (audit as never) : undefined,
    );
    return { service, prisma, audit };
  }

  it('lit le code de la commande par son identifiant, et rien d’autre que le code et la référence', async () => {
    const { service, prisma } = monterCode({ recovery_code: ' 4821 ', reference: 'ORD-261026-00012' });
    await expect(service.codeClient(COMMANDE, ADMIN, T0)).resolves.toBe('4821');
    expect(prisma.order.findUnique).toHaveBeenCalledWith({
      where: { id: UUID },
      select: { recovery_code: true, reference: true },
    });
  });

  it.each([[null], [''], ['   '], [undefined]])('code absent (%p) : null, rien au journal', async (code) => {
    const { service, audit } = monterCode({ recovery_code: code, reference: 'ORD-1' });
    await expect(service.codeClient(COMMANDE, AGENT, T0)).resolves.toBeNull();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('commande introuvable entre-temps : null', async () => {
    const { service } = monterCode(null);
    await expect(service.codeClient(COMMANDE, AGENT, T0)).resolves.toBeNull();
  });

  it('lecture servie au call center : une ligne au journal, sans le code', async () => {
    const { service, audit } = monterCode({ recovery_code: '4821', reference: 'ORD-261026-00012' });
    await service.codeClient(COMMANDE, AGENT, T0);
    expect(audit.record).toHaveBeenCalledTimes(1);
    const ligne = audit.record.mock.calls[0][0];
    expect(ligne).toEqual({
      actor_id: 'agent-1',
      actor_name: 'Awa Koné',
      actor_role: 'CALL_CENTER',
      restaurant_id: 'r1',
      action: 'CODE_CLIENT_LU',
      module: 'orders',
      entity_id: UUID,
      method: 'GET',
      path: `/orders/${UUID}/livraison`,
      status_code: 200,
      summary: 'Code de retrait du client consulté : commande ORD-261026-00012',
    });
    expect(JSON.stringify(ligne)).not.toContain('4821');
  });

  it("lecture de l'administrateur : rien au journal", async () => {
    const { service, audit } = monterCode({ recovery_code: '4821', reference: 'ORD-1' });
    await expect(service.codeClient(COMMANDE, ADMIN, T0)).resolves.toBe('4821');
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('le tiroir relit toutes les 20 s : une ligne par agent et par commande toutes les 10 minutes au plus', async () => {
    const { service, audit } = monterCode({ recovery_code: '4821', reference: 'ORD-1' });
    await service.codeClient(COMMANDE, AGENT, T0);
    await service.codeClient(COMMANDE, AGENT, plus(20_000));
    await service.codeClient(COMMANDE, AGENT, plus(9 * 60_000));
    expect(audit.record).toHaveBeenCalledTimes(1);
    // Un autre agent, une autre commande : leur propre ligne.
    await service.codeClient(COMMANDE, { id: 'agent-2', role: 'CALL_CENTER', email: 'b@cn.ci' } as never, plus(30_000));
    await service.codeClient({ id: 'autre', restaurant_id: 'r2' }, AGENT, plus(40_000));
    expect(audit.record).toHaveBeenCalledTimes(3);
    // Dix minutes après la première ligne : une nouvelle.
    await service.codeClient(COMMANDE, AGENT, plus(10 * 60_000));
    expect(audit.record).toHaveBeenCalledTimes(4);
  });

  it('sans journal branché, le code est rendu quand même', async () => {
    const { service } = monterCode({ recovery_code: '4821', reference: 'ORD-1' }, false);
    await expect(service.codeClient(COMMANDE, AGENT, T0)).resolves.toBe('4821');
  });
});
