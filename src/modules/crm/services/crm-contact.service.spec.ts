/**
 * « Ma file » et l'assignation en masse : les corrections du 02/11, jouées
 * par le VRAI CrmContactService sur une base en mémoire qui évalue les
 * filtres Prisma et compte vraiment (crm-base-memoire.fixture.ts).
 */
jest.mock('src/socket-io/gateways/app.gateway', () => ({ AppGateway: class {} }));
jest.mock('src/database/services/prisma.service', () => ({ PrismaService: class {} }));

import { BadRequestException } from '@nestjs/common';
import { User } from '@prisma/client';
import { CrmAccessService } from './crm-access.service';
import { CrmContactService } from './crm-contact.service';
import { CrmEventsService } from './crm-events.service';
import { Donnees, campagne, contact, monterBase, utilisateur } from './crm-base-memoire.fixture';

const JOUR = 86_400_000;
const ilYA = (jours: number) => new Date(Date.now() - jours * JOUR);

/** Les dossiers de campagne se chargent par l'id de la campagne : un vrai UUID. */
const C1 = '0c1a0000-0000-4000-8000-000000000001';
const S1 = '05a10000-0000-4000-8000-000000000002';

const DIRECTION = utilisateur('u-direction', 'Direction', 'ADMIN') as unknown as User;
const PILOTE = utilisateur('u-pilote', 'Pilote Paul', 'CALL_CENTER') as unknown as User;
const AWA = utilisateur('u-awa', 'Agent Awa', 'CALL_CENTER') as unknown as User;
const YAO = utilisateur('u-yao', 'Agent Yao', 'CALL_CENTER') as unknown as User;

function monter(d: Donnees) {
  const base = monterBase({ users: [DIRECTION, PILOTE, AWA, YAO].map((u) => ({ ...u })), ...d });
  const access = new CrmAccessService(base.prisma);
  const events = new CrmEventsService(base.prisma, { emitToBackoffice: jest.fn() } as any);
  return { ...base, service: new CrmContactService(base.prisma, access, events) };
}

const nombres = (dossiers: { genre: string; nom: string; comptes: { total: number } }[]) =>
  dossiers.map((d) => [d.genre, d.nom, d.comptes.total]);

describe('Ma file : vrais comptes, au-delà des 50 lignes (problème 5)', () => {
  it('60 contacts récents hors campagne ne cachent plus les 30 d’une campagne plus ancienne', async () => {
    const m = monter({
      campagnes: [campagne(C1, { name: 'Relance inactifs', status: 'ACTIVE' })],
      contacts: [
        ...Array.from({ length: 60 }, (_, i) => contact({ assigned_to_id: AWA.id, segment_since: ilYA(1 + i / 100) })),
        ...Array.from({ length: 30 }, () => contact({ segment: 'INACTIF', segment_since: ilYA(40), campaign_id: C1, assigned_to_id: AWA.id })),
      ],
    });
    const f = await m.service.maFile(AWA);
    // L'accueil reste coupé à 50 ; les comptes, eux, sont vrais.
    expect(f.nouveaux).toHaveLength(50);
    expect(f.comptes).toMatchObject({ nouveaux: 90, rappels: 0, commune: 0 });
    expect(nombres(f.dossiers)).toEqual([
      ['campagne', 'Relance inactifs', 30],
      ['sans-campagne', 'Hors campagne', 60],
    ]);
    expect(f.dossiers[0]).toMatchObject({ cle: C1, campaign_id: C1, comptes: { nouveaux: 30, jamais_appeles: 30, a_relancer: 0 } });

    // Le dossier ouvert charge ses lignes à lui, page par page.
    const page1 = await m.service.lignesMaFile(AWA, { cle: C1, rubrique: 'nouveaux', limit: 20 });
    const page2 = await m.service.lignesMaFile(AWA, { cle: C1, rubrique: 'nouveaux', limit: 20, page: 2 });
    expect(page1.meta).toEqual({ total: 30, page: 1, limit: 20, totalPages: 2 });
    expect(page2.data).toHaveLength(10);
    expect(new Set([...page1.data, ...page2.data].map((l) => l.id)).size).toBe(30);
    expect([...page1.data, ...page2.data].every((l) => l.campaign_id === C1)).toBe(true);
  });

  it('la file commune donne son vrai total, séparé entre jamais appelés et à relancer (problème 14)', async () => {
    const m = monter({
      contacts: [
        ...Array.from({ length: 4 }, () => contact({ assigned_to_id: AWA.id, call_count: 2, last_call_at: ilYA(3) })),
        ...Array.from({ length: 300 }, (_, i) => contact({ segment: 'GLOVO', segment_since: ilYA(2 + i), call_count: i < 100 ? 1 : 0 })),
      ],
    });
    const f = await m.service.maFile(AWA);
    expect(f.commune).toHaveLength(50);
    expect(f.comptes.commune).toBe(300);
    const commune = f.dossiers.find((d) => d.genre === 'commune')!;
    expect(commune).toMatchObject({ cle: 'commune', nom: 'File commune Glovo/Yango', campaign_id: null });
    expect(commune.comptes).toMatchObject({ commune: 300, total: 300, jamais_appeles: 200, a_relancer: 100 });
    expect(f.dossiers.find((d) => d.genre === 'sans-campagne')?.comptes).toMatchObject({ total: 4, relances: 4, a_relancer: 4 });
    const lignes = await m.service.lignesMaFile(AWA, { cle: 'commune', rubrique: 'commune', page: 6 });
    expect(lignes.meta.total).toBe(300);
    expect(lignes.data).toHaveLength(50);
  });

  it('les rappels dus se comptent sur toute la file et se chargent avec « toutes »', async () => {
    const m = monter({
      campagnes: [campagne('C1', { status: 'ACTIVE' })],
      contacts: Array.from({ length: 55 }, (_, i) =>
        contact({ status: 'A_RAPPELER', callback_at: ilYA(1 + i / 100), assigned_to_id: AWA.id, campaign_id: i % 2 ? 'C1' : null }),
      ),
    });
    const f = await m.service.maFile(AWA);
    expect(f.rappels).toHaveLength(50);
    expect(f.comptes.rappels).toBe(55);
    // Les rappels dus restent hors des dossiers.
    expect(f.dossiers).toEqual([]);
    expect((await m.service.lignesMaFile(AWA, { cle: 'toutes', rubrique: 'rappels', page: 2 })).data).toHaveLength(5);
  });

  it('dossier ou rubrique incohérents : refusés', async () => {
    const m = monter({});
    for (const q of [
      { cle: 'toutes', rubrique: 'nouveaux' },
      { cle: 'sans-campagne', rubrique: 'rappels' },
      { cle: 'commune', rubrique: 'nouveaux' },
      { cle: 'sans-campagne', rubrique: 'commune' },
      { cle: 'pas-un-id', rubrique: 'nouveaux' },
    ] as const) {
      await expect(m.service.lignesMaFile(AWA, q)).rejects.toThrow(new BadRequestException('Dossier ou rubrique inconnus'));
    }
  });
});

describe('Ma file : campagne suspendue en pause (problème 7)', () => {
  it('ses contacts forment un dossier « pause », hors des listes et du portefeuille', async () => {
    const m = monter({
      campagnes: [campagne(S1, { name: 'Inscrits septembre', status: 'SUSPENDED' })],
      contacts: [
        ...Array.from({ length: 4 }, () => contact({ assigned_to_id: AWA.id, call_count: 1, last_call_at: ilYA(2) })),
        ...Array.from({ length: 20 }, (_, i) => contact({ campaign_id: S1, assigned_to_id: AWA.id, call_count: i < 5 ? 1 : 0 })),
        contact({ campaign_id: S1, assigned_to_id: AWA.id, status: 'NON_INTERESSE' }),
      ],
    });
    const f = await m.service.maFile(AWA);
    expect(f.indicateurs.portefeuille).toBe(4);
    expect(f.nouveaux).toHaveLength(0);
    expect(nombres(f.dossiers)).toEqual([
      ['sans-campagne', 'Hors campagne', 4],
      ['pause', 'Inscrits septembre', 20],
    ]);
    expect(f.dossiers[1]).toMatchObject({ cle: S1, campaign_id: S1, comptes: { total: 20, jamais_appeles: 15, nouveaux: 0 } });
    // Une campagne suspendue n'a pas de lignes à charger.
    expect((await m.service.lignesMaFile(AWA, { cle: S1, rubrique: 'nouveaux' })).meta.total).toBe(0);
  });
});

describe('Ma file : suivi du pilote (problème 4)', () => {
  it('le pilote hors de l’équipe suit sa campagne : restants par agent, sans agent, jamais appelés', async () => {
    const m = monter({
      campagnes: [
        campagne('C1', { name: 'Reconquête', status: 'ACTIVE', distribution_mode: 'MANUEL', lead_agent_id: PILOTE.id }),
        campagne('C2', { name: 'Finie', status: 'COMPLETED', lead_agent_id: PILOTE.id }),
      ],
      contacts: [
        ...Array.from({ length: 5 }, (_, i) => contact({ campaign_id: 'C1', assigned_to_id: AWA.id, call_count: i < 2 ? 1 : 0 })),
        ...Array.from({ length: 2 }, () => contact({ campaign_id: 'C1', assigned_to_id: YAO.id })),
        ...Array.from({ length: 3 }, () => contact({ campaign_id: 'C1' })),
        contact({ campaign_id: 'C1', assigned_to_id: AWA.id, status: 'CONVERTI' }),
      ],
    });
    const f = await m.service.maFile(PILOTE);
    expect(f.dossiers).toEqual([]);
    expect(f.suivi).toEqual([
      {
        campaign_id: 'C1',
        nom: 'Reconquête',
        statut: 'ACTIVE',
        mode: 'MANUEL',
        restants: 10,
        jamais_appeles: 8,
        sans_agent: 3,
        par_agent: [
          { agent_id: AWA.id, nom: 'Agent Awa', restants: 5, jamais_appeles: 3 },
          { agent_id: YAO.id, nom: 'Agent Yao', restants: 2, jamais_appeles: 2 },
        ],
      },
    ]);
    // Un agent qui ne pilote rien n'a pas de suivi.
    expect((await m.service.maFile(AWA)).suivi).toEqual([]);
  });
});

describe('Ma file : une conversion du jour est un contact appelé (problème 14)', () => {
  it('une fiche confiée qui commande sans avoir été appelée ne compte pas', async () => {
    const m = monter({
      contacts: [
        contact({ assigned_to_id: AWA.id, status: 'CONVERTI', converted_at: new Date(), call_count: 1 }),
        contact({ assigned_to_id: AWA.id, status: 'CONVERTI', converted_at: new Date(), call_count: 0 }),
      ],
    });
    expect((await m.service.maFile(AWA)).indicateurs.conversions_jour).toBe(1);
  });
});

describe('Assignation en masse (problème 17, et date de prise du problème 1)', () => {
  it('les convertis sont laissés de côté, le reste est assigné, et le message le dit', async () => {
    const m = monter({
      contacts: [contact(), contact(), contact({ status: 'CONVERTI', converted_at: ilYA(1) })],
    });
    const r = await m.service.assigner(DIRECTION, { contact_ids: m.contacts.map((c) => c.id), agent_id: AWA.id });
    expect(r).toEqual({ count: 2, ecartes: 1, hors_equipe: 0, message: '1 client déjà converti laissé de côté.' });
    expect(m.contacts.filter((c) => c.assigned_to_id === AWA.id)).toHaveLength(2);
    expect(m.contacts[2].assigned_to_id).toBeNull();
  });

  it('un lot de convertis seulement est refusé', async () => {
    const m = monter({ contacts: [contact({ status: 'CONVERTI' }), contact({ status: 'CONVERTI' })] });
    await expect(m.service.assigner(DIRECTION, { contact_ids: m.contacts.map((c) => c.id), agent_id: AWA.id })).rejects.toThrow(
      'Un client qui a déjà commandé ne peut plus être assigné',
    );
  });

  it('la direction peut confier un contact de campagne hors de l’équipe : c’est compté et dit', async () => {
    const m = monter({
      campagnes: [campagne('C1', { status: 'ACTIVE', lead_agent_id: PILOTE.id })],
      equipes: [{ campaign_id: 'C1', agent_id: AWA.id }],
      contacts: [contact({ campaign_id: 'C1' }), contact({ campaign_id: 'C1' }), contact()],
    });
    const r = await m.service.assigner(DIRECTION, { contact_ids: m.contacts.map((c) => c.id), agent_id: YAO.id });
    expect(r).toEqual({ count: 3, ecartes: 0, hors_equipe: 2, message: "2 contacts confiés hors de l'équipe de sa campagne." });
    // Le pilote, lui, reste cantonné à son équipe.
    await expect(m.service.assigner(PILOTE, { contact_ids: [m.contacts[0].id], agent_id: YAO.id })).rejects.toThrow(
      "Cet agent ne fait pas partie de l'équipe de la campagne",
    );
  });

  it('assigner un client de l’annuaire le prend en charge : « à appeler », entrée datée de la prise', async () => {
    const derniereCommande = ilYA(10);
    const m = monter({ contacts: [contact({ segment: 'CLIENT', status: 'NON_DEMARCHE', segment_since: derniereCommande })] });
    const avant = Date.now();
    await m.service.assigner(DIRECTION, { contact_ids: [m.contacts[0].id], agent_id: AWA.id });
    expect(m.contacts[0].status).toBe('A_APPELER');
    expect(m.contacts[0].segment_since.getTime()).toBeGreaterThanOrEqual(avant);
  });
});

describe('Contacts : filtre « À reprendre » (problème 8)', () => {
  it('ne garde que les inscrits et inactifs ouverts, sans agent, hors campagne en cours', async () => {
    const m = monter({
      campagnes: [campagne('FINIE', { status: 'COMPLETED' }), campagne('PAUSE', { status: 'SUSPENDED' })],
      contacts: [
        contact({ name: 'inscrit libre' }),
        contact({ name: 'inactif libre', segment: 'INACTIF' }),
        contact({ name: 'campagne finie', segment: 'INACTIF', campaign_id: 'FINIE' }),
        contact({ name: 'campagne en pause', campaign_id: 'PAUSE' }),
        contact({ name: 'suivi', assigned_to_id: AWA.id }),
        contact({ name: 'refus', status: 'NON_INTERESSE' }),
        contact({ name: 'glovo', segment: 'GLOVO' }),
        contact({ name: 'annuaire', segment: 'CLIENT', status: 'NON_DEMARCHE' }),
        contact({ name: 'supprimé', entity_status: 'DELETED' }),
      ],
    });
    const r = await m.service.lister(DIRECTION, { a_reprendre: 'true' });
    expect(r.data.map((l) => l.name).sort()).toEqual(['campagne finie', 'inactif libre', 'inscrit libre']);
    expect(r.meta.total).toBe(3);
  });
});
