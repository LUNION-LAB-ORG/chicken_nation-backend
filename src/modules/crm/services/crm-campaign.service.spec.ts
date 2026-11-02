/**
 * Campagnes : les corrections du 02/11 (analyse « campagnes et Ma file »),
 * jouées par le VRAI CrmCampaignService sur une base en mémoire qui évalue
 * les filtres Prisma (crm-base-memoire.fixture.ts).
 */
jest.mock('src/socket-io/gateways/app.gateway', () => ({ AppGateway: class {} }));
jest.mock('src/database/services/prisma.service', () => ({ PrismaService: class {} }));

import { User } from '@prisma/client';
import { jourUTC } from '../crm-campagne.rules';
import { CrmAccessService } from './crm-access.service';
import { CrmCampaignService } from './crm-campaign.service';
import { CrmContactService } from './crm-contact.service';
import { CrmEventsService } from './crm-events.service';
import { Donnees, campagne, contact, monterBase, publicDe, utilisateur } from './crm-base-memoire.fixture';

const JOUR = 86_400_000;
const ilYA = (jours: number) => new Date(Date.now() - jours * JOUR);
const dans = (jours: number) => new Date(Date.now() + jours * JOUR);

const DIRECTION = utilisateur('u-direction', 'Direction', 'ADMIN') as unknown as User;
const PILOTE = utilisateur('u-pilote', 'Pilote Paul', 'CALL_CENTER') as unknown as User;
const AWA = utilisateur('u-awa', 'Agent Awa', 'CALL_CENTER') as unknown as User;
const YAO = utilisateur('u-yao', 'Agent Yao', 'CALL_CENTER') as unknown as User;
const KOFFI = utilisateur('u-koffi', 'Agent Koffi', 'CALL_CENTER') as unknown as User;
const MARKETING = utilisateur('u-marketing', 'Marketing Mia', 'MARKETING') as unknown as User;

const tous = () => [DIRECTION, PILOTE, AWA, YAO, KOFFI, MARKETING].map((u) => ({ ...u }));
const equipe = (campaign_id: string, ...agents: User[]) => agents.map((a) => ({ campaign_id, agent_id: a.id }));
const inactifs = (n: number, surcharge: Record<string, unknown> = {}) =>
  Array.from({ length: n }, (_, i) => contact({ segment: 'INACTIF', segment_since: ilYA(40 + i), ...surcharge }));

function monter(d: Donnees) {
  const base = monterBase({ users: tous(), ...d });
  const access = new CrmAccessService(base.prisma);
  const gateway = { emitToBackoffice: jest.fn() };
  const events = new CrmEventsService(base.prisma, gateway as any);
  const stats = { statistiques: jest.fn(async () => ({})), resumes: jest.fn(async () => new Map()) };
  const service = new CrmCampaignService(base.prisma, access, events, stats as any, {} as any);
  const file = new CrmContactService(base.prisma, access, events);
  const contactsDe = (agent: User, campagneId?: string) =>
    base.contacts.filter((c) => c.assigned_to_id === agent.id && (campagneId === undefined || c.campaign_id === campagneId));
  return { ...base, access, events, gateway, service, file, contactsDe };
}

describe('Mode manuel : les contacts non répartis vont au pilote (problème 2)', () => {
  it('au lancement, le pilote reçoit tout ce qui n’est pas déjà suivi par un agent de l’équipe', async () => {
    const liste = inactifs(6);
    liste[0].assigned_to_id = AWA.id;
    const m = monter({
      campagnes: [campagne('C1', { distribution_mode: 'MANUEL', lead_agent_id: PILOTE.id, start_date: ilYA(1) })],
      equipes: equipe('C1', AWA, YAO),
      publics: [publicDe('C1', 'INACTIF')],
      contacts: liste,
    });
    const r = await m.service.lancer(DIRECTION, 'C1');
    expect(r).toMatchObject({ cibles: 6, repartis: 6, au_pilote: 5 });
    expect(m.contactsDe(PILOTE, 'C1')).toHaveLength(5);
    expect(m.contactsDe(AWA, 'C1').map((c) => c.id)).toEqual([liste[0].id]);
    // Le pilote les voit dans sa file, en dossier de la campagne.
    const f = await m.file.maFile(PILOTE);
    expect(f.dossiers.find((d) => d.cle === 'C1')?.comptes.nouveaux).toBe(5);
  });

  it('pilote désactivé : les contacts restent sans agent, rien n’est confié', async () => {
    const m = monter({
      campagnes: [campagne('C1', { distribution_mode: 'MANUEL', lead_agent_id: PILOTE.id, start_date: ilYA(1) })],
      equipes: equipe('C1', AWA),
      publics: [publicDe('C1', 'INACTIF')],
      contacts: inactifs(3),
    });
    m.users.find((u) => u.id === PILOTE.id)!.entity_status = 'INACTIVE';
    const r = await m.service.lancer(DIRECTION, 'C1');
    expect(r).toMatchObject({ cibles: 3, repartis: 0, au_pilote: 0 });
  });

  it('agent retiré en cours de campagne : ses contacts ouverts vont au pilote, les autres sont libérés', async () => {
    const ouverts = inactifs(3, { campaign_id: 'C1', assigned_to_id: AWA.id });
    const refuse = contact({ segment: 'INACTIF', status: 'NON_INTERESSE', campaign_id: 'C1', assigned_to_id: AWA.id });
    const m = monter({
      campagnes: [campagne('C1', { status: 'ACTIVE', distribution_mode: 'MANUEL', lead_agent_id: PILOTE.id, started_at: ilYA(2) })],
      equipes: equipe('C1', AWA, YAO),
      contacts: [...ouverts, refuse],
      membres: [...ouverts, refuse].map((c) => ({ campaign_id: 'C1', contact_id: c.id, agent_id: AWA.id, released_at: null, segment: 'INACTIF', cycle: 1 })),
    });
    await m.service.modifierEquipe(DIRECTION, 'C1', { agent_ids: [YAO.id] });
    expect(m.contactsDe(PILOTE, 'C1')).toHaveLength(3);
    expect(m.membres.filter((x) => x.agent_id === PILOTE.id)).toHaveLength(3);
    expect(m.contacts.find((c) => c.id === refuse.id)?.assigned_to_id).toBeNull();
    expect(m.evenements.filter((e) => e.label === "Confié au pilote : son agent a quitté l'équipe")).toHaveLength(3);
  });

  it('pilote et agent retirés ensemble : les contacts de l’agent vont au pilote, ceux du pilote restent sans agent', async () => {
    const chezAwa = inactifs(3, { campaign_id: 'C1', assigned_to_id: AWA.id });
    const chezPilote = inactifs(2, { campaign_id: 'C1', assigned_to_id: PILOTE.id });
    const m = monter({
      campagnes: [campagne('C1', { status: 'ACTIVE', distribution_mode: 'MANUEL', lead_agent_id: PILOTE.id, started_at: ilYA(2) })],
      equipes: equipe('C1', PILOTE, AWA, YAO),
      contacts: [...chezAwa, ...chezPilote],
      membres: [...chezAwa, ...chezPilote].map((c) => ({
        campaign_id: 'C1',
        contact_id: c.id,
        agent_id: c.assigned_to_id,
        released_at: null,
        segment: 'INACTIF',
        cycle: 1,
      })),
    });
    await m.service.modifierEquipe(DIRECTION, 'C1', { agent_ids: [YAO.id] });
    const fiche = (id: string) => m.contacts.find((c) => c.id === id)!;
    const membre = (id: string) => m.membres.find((x) => x.contact_id === id)!;
    expect(chezAwa.map((c) => fiche(c.id).assigned_to_id)).toEqual([PILOTE.id, PILOTE.id, PILOTE.id]);
    expect(chezAwa.map((c) => membre(c.id).agent_id)).toEqual([PILOTE.id, PILOTE.id, PILOTE.id]);
    expect(chezPilote.map((c) => fiche(c.id).assigned_to_id)).toEqual([null, null]);
    // Le journal dit vrai : trois contacts confiés au pilote, et ils y sont.
    expect(m.evenements.filter((e) => e.label === "Confié au pilote : son agent a quitté l'équipe")).toHaveLength(3);
  });

  it('« Répartir équitablement » répartit ce que tient le pilote dans l’équipe, sauf ce qu’il a déjà travaillé', async () => {
    const auPilote = inactifs(6, { campaign_id: 'C1', assigned_to_id: PILOTE.id });
    const appele = contact({ segment: 'INACTIF', campaign_id: 'C1', assigned_to_id: PILOTE.id, call_count: 1, last_call_at: ilYA(1) });
    const coupon = contact({ segment: 'INACTIF', campaign_id: 'C1', assigned_to_id: PILOTE.id, status: 'COUPON_ENVOYE', coupon_sent_at: ilYA(1) });
    const tous = [...auPilote, appele, coupon];
    const m = monter({
      campagnes: [campagne('C1', { status: 'ACTIVE', distribution_mode: 'MANUEL', lead_agent_id: PILOTE.id, started_at: ilYA(1) })],
      // Case « Le pilote fait partie de l'équipe » cochée (défaut).
      equipes: equipe('C1', PILOTE, AWA, YAO),
      contacts: tous,
      membres: tous.map((c) => ({ campaign_id: 'C1', contact_id: c.id, agent_id: PILOTE.id, released_at: null, segment: 'INACTIF', cycle: 1 })),
    });
    const r = await m.service.distribuer(PILOTE, 'C1', {});
    // Le pilote garde ses deux contacts travaillés et reçoit sa part comme les autres.
    expect(r).toEqual({ repartis: 5, par_agent: { [AWA.id]: 3, [YAO.id]: 2 } });
    expect(m.contactsDe(AWA, 'C1')).toHaveLength(3);
    expect(m.contactsDe(YAO, 'C1')).toHaveLength(2);
    expect(m.contactsDe(PILOTE, 'C1').map((c) => c.id)).toEqual(expect.arrayContaining([appele.id, coupon.id]));
    expect(m.contactsDe(PILOTE, 'C1')).toHaveLength(3);
    for (const x of m.membres) expect(x.agent_id).toBe(m.contacts.find((c) => c.id === x.contact_id)!.assigned_to_id);
    // Un second clic ne bouge rien et n'écrit rien au journal.
    expect(await m.service.distribuer(PILOTE, 'C1', {})).toEqual({ repartis: 0, par_agent: {} });
    expect(m.evenements.filter((e) => e.label === 'Réparti automatiquement dans la campagne')).toHaveLength(5);
  });

  it('le pilote retiré de l’équipe ne se rend pas ses contacts : ils restent sans agent', async () => {
    const siens = inactifs(2, { campaign_id: 'C1', assigned_to_id: PILOTE.id });
    const m = monter({
      campagnes: [campagne('C1', { status: 'ACTIVE', distribution_mode: 'MANUEL', lead_agent_id: PILOTE.id, started_at: ilYA(2) })],
      equipes: equipe('C1', PILOTE, AWA),
      contacts: siens,
      membres: siens.map((c) => ({ campaign_id: 'C1', contact_id: c.id, agent_id: PILOTE.id, released_at: null, segment: 'INACTIF', cycle: 1 })),
    });
    await m.service.modifierEquipe(DIRECTION, 'C1', { agent_ids: [AWA.id] });
    expect(m.contacts.every((c) => c.assigned_to_id === null)).toBe(true);
  });
});

describe('Lancement automatique à la date de début (problème 3)', () => {
  it('lance les campagnes dues par le même lancement que le bouton, sans acteur au journal', async () => {
    const m = monter({
      campagnes: [
        campagne('DUE', { lead_agent_id: PILOTE.id, start_date: ilYA(0.5), launch_error: 'ancien refus' }),
        campagne('FUTURE', { lead_agent_id: PILOTE.id, start_date: dans(2) }),
      ],
      equipes: [...equipe('DUE', AWA), ...equipe('FUTURE', AWA)],
      publics: [publicDe('DUE', 'INACTIF'), publicDe('FUTURE', 'INACTIF')],
      contacts: inactifs(4),
    });
    const r = await m.service.lancerPlanifiees();
    expect(r).toEqual({ lancees: 1, refusees: 0, pannes: 0 });
    const due = m.campagnes.find((c) => c.id === 'DUE')!;
    expect(due).toMatchObject({ status: 'ACTIVE', launch_error: null, launch_failed_at: null });
    expect(m.campagnes.find((c) => c.id === 'FUTURE')?.status).toBe('PLANIFIED');
    const entrees = m.evenements.filter((e) => e.type === 'CAMPAGNE_ENTREE');
    expect(entrees).toHaveLength(4);
    expect(entrees.every((e) => e.actor_id === null)).toBe(true);
  });

  it('refus (aucun contact) : la campagne reste planifiée, le refus est sur la carte et réessayé l’heure suivante', async () => {
    const m = monter({
      campagnes: [campagne('C1', { lead_agent_id: PILOTE.id, start_date: ilYA(1) })],
      equipes: equipe('C1', AWA),
      publics: [publicDe('C1', 'INACTIF')],
    });
    expect(await m.service.lancerPlanifiees()).toEqual({ lancees: 0, refusees: 1, pannes: 0 });
    let c = m.campagnes.find((x) => x.id === 'C1')!;
    expect(c).toMatchObject({ status: 'PLANIFIED', launch_error: 'Aucun contact disponible pour cette population', launch_failed_at: null });
    expect(c.started_at).toBeNull();

    // L'heure suivante, des contacts sont arrivés : elle part.
    m.contacts.push(...inactifs(2));
    expect(await m.service.lancerPlanifiees()).toEqual({ lancees: 1, refusees: 0, pannes: 0 });
    c = m.campagnes.find((x) => x.id === 'C1')!;
    expect(c).toMatchObject({ status: 'ACTIVE', launch_error: null });
  });

  it('refus (équipe vide) écrit une seule fois ; la modification de la campagne l’efface', async () => {
    const m = monter({
      campagnes: [campagne('C1', { lead_agent_id: PILOTE.id, start_date: ilYA(1) })],
      publics: [publicDe('C1', 'INACTIF')],
      contacts: inactifs(2),
    });
    const ecrire = jest.spyOn(m.prisma.crmCampaign, 'updateMany');
    await m.service.lancerPlanifiees();
    await m.service.lancerPlanifiees();
    expect(m.campagnes[0].launch_error).toBe("L'équipe de la campagne est vide");
    expect(ecrire).toHaveBeenCalledTimes(1);

    await m.service.modifier('C1', { name: 'Campagne revue' });
    expect(m.campagnes[0].launch_error).toBeNull();
  });

  it('panne : plus aucun essai automatique, la carte dit de la lancer à la main ; le bouton efface la panne', async () => {
    const m = monter({
      campagnes: [campagne('C1', { lead_agent_id: PILOTE.id, start_date: ilYA(1) })],
      equipes: equipe('C1', AWA),
      publics: [publicDe('C1', 'INACTIF')],
      contacts: inactifs(2),
    });
    const lire = m.prisma.crmContact.findMany;
    m.prisma.crmContact.findMany = jest.fn(async () => {
      throw new Error('Transaction already closed: timeout');
    });
    expect(await m.service.lancerPlanifiees()).toEqual({ lancees: 0, refusees: 0, pannes: 1 });
    expect(m.campagnes[0]).toMatchObject({ status: 'PLANIFIED', launch_error: 'Le lancement a échoué : lancez-la à la main' });
    expect(m.campagnes[0].launch_failed_at).toBeInstanceOf(Date);

    m.prisma.crmContact.findMany = lire;
    const lancer = jest.spyOn(m.service, 'lancer');
    expect(await m.service.lancerPlanifiees()).toEqual({ lancees: 0, refusees: 0, pannes: 0 });
    expect(lancer).not.toHaveBeenCalled();

    await m.service.lancer(DIRECTION, 'C1');
    expect(m.campagnes[0]).toMatchObject({ status: 'ACTIVE', launch_error: null, launch_failed_at: null });
  });

  it('planifiée dont la date de fin est passée sans lancement : pas lancée, close par la tâche des clôtures', async () => {
    const m = monter({
      campagnes: [
        campagne('ECHUE', { lead_agent_id: PILOTE.id, start_date: ilYA(10), end_date: jourUTC(ilYA(3)) }),
        campagne('DUREE', { lead_agent_id: PILOTE.id, start_date: dans(3), end_date: jourUTC(ilYA(3)), duration_days: 7 }),
      ],
      equipes: equipe('ECHUE', AWA),
      publics: [publicDe('ECHUE', 'INACTIF')],
      contacts: inactifs(2),
    });
    expect((await m.service.lancerPlanifiees()).lancees).toBe(0);
    expect(await m.service.cloreNonLancees()).toBe(1);
    const echue = m.campagnes.find((c) => c.id === 'ECHUE')!;
    expect(echue.status).toBe('COMPLETED');
    expect(echue.completed_at).toBeInstanceOf(Date);
    expect(echue.report).toBeNull();
    // « Après N jours » : la fin n'est que provisoire, elle ne clôt rien.
    expect(m.campagnes.find((c) => c.id === 'DUREE')?.status).toBe('PLANIFIED');
  });

  it('la liste signale une date de début passée sans lancement', async () => {
    const m = monter({
      campagnes: [
        campagne('PASSEE', { lead_agent_id: PILOTE.id, start_date: ilYA(1) }),
        campagne('FUTURE', { lead_agent_id: PILOTE.id, start_date: dans(1) }),
        campagne('ENCOURS', { lead_agent_id: PILOTE.id, start_date: ilYA(5), status: 'ACTIVE' }),
      ],
    });
    const liste = await m.service.lister(DIRECTION, {});
    expect(Object.fromEntries(liste.map((c) => [c.id, c.date_debut_passee]))).toEqual({ PASSEE: true, FUTURE: false, ENCOURS: false });
  });
});

describe('Durée « Après N jours » comptée depuis le lancement (problème 13)', () => {
  it('lancée 5 jours après sa date de début, une campagne de 7 jours finit 6 jours après le lancement', async () => {
    const m = monter({
      campagnes: [
        campagne('C1', {
          lead_agent_id: PILOTE.id,
          start_date: jourUTC(ilYA(5)),
          duration_days: 7,
          // Fin provisoire calculée depuis le début saisi : déjà passée, sans bloquer le lancement.
          end_date: jourUTC(ilYA(-1)),
        }),
      ],
      equipes: equipe('C1', AWA),
      publics: [publicDe('C1', 'INACTIF')],
      contacts: inactifs(2),
    });
    await m.service.lancer(DIRECTION, 'C1');
    expect(m.campagnes[0].end_date).toEqual(new Date(jourUTC(new Date()).getTime() + 6 * JOUR));
  });

  it('changer la durée d’une campagne lancée recompte depuis son lancement', async () => {
    const m = monter({
      campagnes: [campagne('C1', { lead_agent_id: PILOTE.id, status: 'ACTIVE', start_date: jourUTC(ilYA(10)), started_at: ilYA(4) })],
    });
    const r = await m.service.modifier('C1', { duration_days: 10 });
    expect(r.duration_days).toBe(10);
    expect(m.campagnes[0].end_date).toEqual(new Date(jourUTC(ilYA(4)).getTime() + 9 * JOUR));
  });

  it('création : la durée est gardée ; une date de fin saisie l’emporte', async () => {
    const m = monter({});
    m.prisma.restaurant = { count: async () => 0 };
    const base = { name: 'Relance', start_date: '2026-12-01', lead_agent_id: PILOTE.id, agent_ids: [AWA.id] };
    const avecDuree = await m.service.creer(DIRECTION, { ...base, duration_days: 7 });
    expect(avecDuree).toMatchObject({ duration_days: 7, end_date: new Date('2026-12-07T00:00:00.000Z') });
    const avecFin = await m.service.creer(DIRECTION, { ...base, duration_days: 7, end_date: '2026-12-20' });
    expect(avecFin).toMatchObject({ duration_days: null, end_date: new Date('2026-12-20T00:00:00.000Z') });
  });
});

describe('Effacer la date de fin (problème 19)', () => {
  it('end_date: null efface la fin et la durée', async () => {
    const m = monter({
      campagnes: [campagne('C1', { lead_agent_id: PILOTE.id, start_date: dans(2), end_date: dans(9), duration_days: 8 })],
    });
    const r = await m.service.modifier('C1', { end_date: null });
    expect(r).toMatchObject({ end_date: null, duration_days: null });
  });

  it('une date de fin saisie remplace la durée', async () => {
    const m = monter({ campagnes: [campagne('C1', { lead_agent_id: PILOTE.id, start_date: jourUTC(dans(2)), duration_days: 8 })] });
    const fin = jourUTC(dans(20)).toISOString().slice(0, 10);
    const r = await m.service.modifier('C1', { end_date: fin });
    expect(r).toMatchObject({ duration_days: null, end_date: new Date(`${fin}T00:00:00.000Z`) });
  });
});

describe('Agent ajouté à une campagne en cours (problème 6)', () => {
  it('répartition automatique : il reçoit sa part des contacts jamais appelés, les appelés restent', async () => {
    const jamais = inactifs(8, { campaign_id: 'C1', assigned_to_id: AWA.id });
    const appele = contact({ segment: 'INACTIF', campaign_id: 'C1', assigned_to_id: AWA.id, call_count: 2, last_call_at: ilYA(1) });
    const m = monter({
      campagnes: [campagne('C1', { status: 'ACTIVE', lead_agent_id: PILOTE.id, started_at: ilYA(3) })],
      equipes: equipe('C1', AWA),
      contacts: [...jamais, appele],
      membres: [...jamais, appele].map((c) => ({ campaign_id: 'C1', contact_id: c.id, agent_id: AWA.id, released_at: null, segment: 'INACTIF', cycle: 1 })),
    });
    await m.service.modifierEquipe(DIRECTION, 'C1', { agent_ids: [AWA.id, KOFFI.id] });
    expect(m.contactsDe(KOFFI, 'C1')).toHaveLength(4);
    expect(m.contactsDe(AWA, 'C1')).toHaveLength(5);
    expect(m.contacts.find((c) => c.id === appele.id)?.assigned_to_id).toBe(AWA.id);
  });

  it('un coupon envoyé sans appel reste à son agent : seul un contact « à appeler » jamais appelé change de main', async () => {
    const jamais = inactifs(4, { campaign_id: 'C1', assigned_to_id: AWA.id });
    // Trié juste après le premier : avant la correction, il partait chez Koffi.
    const coupon = contact({
      segment: 'INACTIF',
      segment_since: ilYA(40.5),
      campaign_id: 'C1',
      assigned_to_id: AWA.id,
      status: 'COUPON_ENVOYE',
      coupon_sent_at: ilYA(1),
    });
    const m = monter({
      campagnes: [campagne('C1', { status: 'ACTIVE', lead_agent_id: PILOTE.id, started_at: ilYA(3) })],
      equipes: equipe('C1', AWA),
      contacts: [...jamais, coupon],
      membres: [...jamais, coupon].map((c) => ({ campaign_id: 'C1', contact_id: c.id, agent_id: AWA.id, released_at: null, segment: 'INACTIF', cycle: 1 })),
    });
    await m.service.modifierEquipe(DIRECTION, 'C1', { agent_ids: [AWA.id, KOFFI.id] });
    expect(m.contacts.find((c) => c.id === coupon.id)?.assigned_to_id).toBe(AWA.id);
    expect(m.contactsDe(KOFFI, 'C1')).toHaveLength(2);
    expect(m.contactsDe(AWA, 'C1')).toHaveLength(3);
    // Seuls les contacts qui ont vraiment changé d'agent sont au journal.
    expect(m.evenements.filter((e) => e.label === 'Réparti automatiquement dans la campagne')).toHaveLength(2);
  });

  it('répartition manuelle : l’agent ajouté ne reçoit rien tout seul', async () => {
    const siens = inactifs(4, { campaign_id: 'C1', assigned_to_id: AWA.id });
    const m = monter({
      campagnes: [campagne('C1', { status: 'ACTIVE', distribution_mode: 'MANUEL', lead_agent_id: PILOTE.id, started_at: ilYA(3) })],
      equipes: equipe('C1', AWA),
      contacts: siens,
      membres: siens.map((c) => ({ campaign_id: 'C1', contact_id: c.id, agent_id: AWA.id, released_at: null, segment: 'INACTIF', cycle: 1 })),
    });
    await m.service.modifierEquipe(DIRECTION, 'C1', { agent_ids: [AWA.id, KOFFI.id] });
    expect(m.contactsDe(KOFFI)).toHaveLength(0);
  });
});

describe('Suspension (problèmes 7 et 20)', () => {
  it('suspendre date la suspension et réarme l’alerte ; reprendre efface les deux ; les écrans sont prévenus', async () => {
    const ouverts = inactifs(3, { campaign_id: 'C1', assigned_to_id: AWA.id });
    const m = monter({
      campagnes: [campagne('C1', { status: 'ACTIVE', lead_agent_id: PILOTE.id, suspension_alert_sent_at: ilYA(30) })],
      contacts: [...ouverts, contact({ segment: 'INACTIF', campaign_id: 'C1', status: 'NON_INTERESSE' })],
    });
    await m.service.suspendre(DIRECTION, 'C1');
    expect(m.campagnes[0].status).toBe('SUSPENDED');
    expect(m.campagnes[0].suspended_at).toBeInstanceOf(Date);
    expect(m.campagnes[0].suspension_alert_sent_at).toBeNull();
    expect(m.gateway.emitToBackoffice).toHaveBeenLastCalledWith(expect.any(String), {
      ids: ouverts.map((c) => c.id),
      motif: 'campagne',
    });

    await m.service.reprendre(DIRECTION, 'C1');
    expect(m.campagnes[0]).toMatchObject({ status: 'ACTIVE', suspended_at: null, suspension_alert_sent_at: null });
    expect(m.gateway.emitToBackoffice).toHaveBeenCalledTimes(2);
  });
});

describe('Ajout quotidien du vivier « à reprendre » (problème 8)', () => {
  it('une campagne automatique en cours reprend les inactifs libres qui répondent à ses critères, et les répartit', async () => {
    const dejaChezAwa = inactifs(2, { campaign_id: 'C1', assigned_to_id: AWA.id });
    const libres = inactifs(3);
    const horsPeriode = contact({ segment: 'INACTIF', segment_since: ilYA(400) });
    const suivi = contact({ segment: 'INACTIF', assigned_to_id: KOFFI.id });
    const autreCampagne = contact({ segment: 'INACTIF', campaign_id: 'C9' });
    const inscrit = contact({ segment: 'JAMAIS_COMMANDE' });
    const glovo = contact({ segment: 'GLOVO', segment_since: ilYA(3) });
    const m = monter({
      campagnes: [
        campagne('C1', { status: 'ACTIVE', lead_agent_id: PILOTE.id, started_at: ilYA(5), targeted_count: 2 }),
        campagne('C9', { status: 'ACTIVE', distribution_mode: 'MANUEL', lead_agent_id: PILOTE.id, started_at: ilYA(5) }),
      ],
      equipes: [...equipe('C1', AWA, YAO), ...equipe('C9', KOFFI)],
      publics: [
        publicDe('C1', 'INACTIF', { period_from: ilYA(100), targeted_count: 2 }),
        publicDe('C1', 'GLOVO'),
        publicDe('C9', 'JAMAIS_COMMANDE'),
      ],
      contacts: [...dejaChezAwa, ...libres, horsPeriode, suivi, autreCampagne, inscrit, glovo],
      membres: dejaChezAwa.map((c) => ({ campaign_id: 'C1', contact_id: c.id, agent_id: AWA.id, released_at: null, segment: 'INACTIF', cycle: 1 })),
    });
    const bilan = await m.service.rejoindreCampagnes();
    expect(bilan).toEqual([{ campagne: 'Campagne C1', entres: 3 }]);
    expect(libres.every((c) => m.contacts.find((x) => x.id === c.id)?.campaign_id === 'C1')).toBe(true);
    // Équilibré avec la charge actuelle : Awa en avait 2, Yao 0 ; 3 et 2 à la fin.
    expect(m.contactsDe(YAO, 'C1')).toHaveLength(2);
    expect(m.contactsDe(AWA, 'C1')).toHaveLength(3);
    expect(m.campagnes[0].targeted_count).toBe(5);
    expect(m.publics.find((p) => p.campaign_id === 'C1' && p.segment === 'INACTIF')?.targeted_count).toBe(5);
    expect(m.membres.filter((x) => x.campaign_id === 'C1')).toHaveLength(5);
    expect(m.evenements.filter((e) => e.label === 'Entre dans la campagne « Campagne C1 » (ajout du jour)')).toHaveLength(3);
    // Hors critères, suivi par un agent, dans une autre campagne, Glovo, ou visé seulement par une campagne manuelle : rien.
    for (const x of [horsPeriode, suivi, autreCampagne, inscrit, glovo]) {
      expect(m.contacts.find((c) => c.id === x.id)?.campaign_id ?? null).toBe(x.campaign_id);
    }
    // Un second passage (second serveur, ou le lendemain) ne reprend rien de plus.
    expect(await m.service.rejoindreCampagnes()).toEqual([]);
  });

  it('deux serveurs : le second, qui avait lu le même paquet, ne réécrit pas les membres pris par le premier', async () => {
    const dejaChezAwa = inactifs(1, { campaign_id: 'C1', assigned_to_id: AWA.id });
    const libres = inactifs(3);
    const m = monter({
      campagnes: [campagne('C1', { status: 'ACTIVE', lead_agent_id: PILOTE.id, started_at: ilYA(5) })],
      equipes: equipe('C1', AWA, YAO),
      publics: [publicDe('C1', 'INACTIF')],
      contacts: [...dejaChezAwa, ...libres],
      membres: dejaChezAwa.map((c) => ({ campaign_id: 'C1', contact_id: c.id, agent_id: AWA.id, released_at: null, segment: 'INACTIF', cycle: 1 })),
    });
    // Le paquet que le second serveur a lu avant que le premier écrive.
    const luParLeSecond = libres.map((c) => ({ id: c.id, assigned_to_id: null, segment: 'INACTIF', cycle: 1 }));
    expect(await m.service.rejoindreCampagnes()).toEqual([{ campagne: 'Campagne C1', entres: 3 }]);
    // Le second passe après le verrou du premier : les charges ont changé, sa répartition aussi.
    const second = (m.service as any).rejoindre(
      'C1',
      'Campagne C1',
      'INACTIF',
      [AWA.id, YAO.id],
      luParLeSecond,
      { assigned_to_id: null },
      new Date(Date.now() + 1_000),
    );
    expect(await second).toBe(0);
    for (const x of m.membres) expect(x.agent_id).toBe(m.contacts.find((c) => c.id === x.contact_id)!.assigned_to_id);
    expect(m.evenements.filter((e) => e.label === 'Entre dans la campagne « Campagne C1 » (ajout du jour)')).toHaveLength(3);
  });

  it('un contact déjà passé par la campagne n’y revient pas', async () => {
    const revenu = contact({ segment: 'INACTIF', cycle: 2 });
    const m = monter({
      campagnes: [campagne('C1', { status: 'ACTIVE', lead_agent_id: PILOTE.id, started_at: ilYA(5) })],
      equipes: equipe('C1', AWA),
      publics: [publicDe('C1', 'INACTIF')],
      contacts: [revenu],
      membres: [{ campaign_id: 'C1', contact_id: revenu.id, agent_id: AWA.id, released_at: ilYA(2), segment: 'INACTIF', cycle: 1 }],
    });
    expect(await m.service.rejoindreCampagnes()).toEqual([]);
  });

  it('la plus ancienne campagne se sert d’abord ; une campagne sans agent actif est sautée', async () => {
    const libres = inactifs(2);
    const m = monter({
      campagnes: [
        campagne('RECENTE', { status: 'ACTIVE', lead_agent_id: PILOTE.id, started_at: ilYA(1) }),
        campagne('ANCIENNE', { status: 'ACTIVE', lead_agent_id: PILOTE.id, started_at: ilYA(9) }),
        campagne('VIDE', { status: 'ACTIVE', lead_agent_id: PILOTE.id, started_at: ilYA(20) }),
      ],
      equipes: [...equipe('RECENTE', AWA), ...equipe('ANCIENNE', YAO)],
      publics: [publicDe('RECENTE', 'INACTIF'), publicDe('ANCIENNE', 'INACTIF'), publicDe('VIDE', 'INACTIF')],
      contacts: libres,
    });
    expect(await m.service.rejoindreCampagnes()).toEqual([{ campagne: 'Campagne ANCIENNE', entres: 2 }]);
  });

  it('par paquets de 2 000 : 2 001 contacts entrent en deux transactions', async () => {
    const m = monter({
      campagnes: [campagne('C1', { status: 'ACTIVE', lead_agent_id: PILOTE.id, started_at: ilYA(5) })],
      equipes: equipe('C1', AWA, YAO),
      publics: [publicDe('C1', 'JAMAIS_COMMANDE')],
      contacts: Array.from({ length: 2001 }, () => contact({ segment: 'JAMAIS_COMMANDE' })),
    });
    const transactions = jest.spyOn(m.prisma, '$transaction');
    expect(await m.service.rejoindreCampagnes()).toEqual([{ campagne: 'Campagne C1', entres: 2001 }]);
    expect(transactions).toHaveBeenCalledTimes(2);
    expect(m.contactsDe(AWA, 'C1').length + m.contactsDe(YAO, 'C1').length).toBe(2001);
  });
});

describe('Agents partis : leurs fiches ouvertes sont libérées (problème 8)', () => {
  it('hors campagne : libérées (Glovo vers la file commune) ; en campagne automatique : redonnées à l’équipe ; manuelle : au pilote', async () => {
    const glovo = contact({ segment: 'GLOVO', segment_since: ilYA(5), assigned_to_id: AWA.id, call_count: 1 });
    const inscrit = contact({ segment: 'JAMAIS_COMMANDE', assigned_to_id: AWA.id });
    const ferme = contact({ segment: 'INACTIF', status: 'NON_INTERESSE', assigned_to_id: AWA.id });
    const auto = inactifs(2, { campaign_id: 'AUTO', assigned_to_id: AWA.id });
    const manuel = inactifs(2, { campaign_id: 'MANU', assigned_to_id: AWA.id });
    const m = monter({
      campagnes: [
        campagne('AUTO', { status: 'ACTIVE', lead_agent_id: PILOTE.id, started_at: ilYA(5) }),
        campagne('MANU', { status: 'ACTIVE', distribution_mode: 'MANUEL', lead_agent_id: PILOTE.id, started_at: ilYA(5) }),
      ],
      equipes: [...equipe('AUTO', AWA, YAO), ...equipe('MANU', AWA, KOFFI)],
      contacts: [glovo, inscrit, ferme, ...auto, ...manuel],
      membres: [...auto, ...manuel].map((c) => ({
        campaign_id: c.campaign_id,
        contact_id: c.id,
        agent_id: AWA.id,
        released_at: null,
        segment: 'INACTIF',
        cycle: 1,
      })),
    });
    m.users.find((u) => u.id === AWA.id)!.entity_status = 'INACTIVE';

    expect(await m.service.libererAgentsPartis()).toEqual({ liberes: 6, campagnes: 2 });
    const fiche = (id: string) => m.contacts.find((c) => c.id === id)!;
    expect(m.access.dansFileCommune(fiche(glovo.id) as any)).toBe(true);
    expect(fiche(inscrit.id).assigned_to_id).toBeNull();
    // Un contact fermé (pas intéressé) n'est pas touché.
    expect(fiche(ferme.id).assigned_to_id).toBe(AWA.id);
    expect(auto.every((c) => fiche(c.id).assigned_to_id === YAO.id)).toBe(true);
    expect(manuel.every((c) => fiche(c.id).assigned_to_id === PILOTE.id)).toBe(true);
    expect(m.evenements.filter((e) => e.label === "Libéré : son agent n'est plus actif")).toHaveLength(6);
    // Le journal dit où sont les fiches : chez le pilote (manuelle), réparties (automatique).
    const auPilote = m.evenements.filter((e) => e.label === "Confié au pilote : son agent n'est plus actif");
    expect(auPilote.map((e) => e.contact_id).sort()).toEqual(manuel.map((c) => c.id).sort());
    expect(auPilote.every((e) => e.actor_id === null && e.campaign_id === 'MANU')).toBe(true);
    expect(m.evenements.filter((e) => e.label === 'Réparti automatiquement dans la campagne')).toHaveLength(2);
    for (const x of m.membres) expect(x.agent_id).toBe(fiche(x.contact_id).assigned_to_id);

    // Second passage (ou second serveur) : rien à faire, rien au journal.
    expect(await m.service.libererAgentsPartis()).toEqual({ liberes: 0, campagnes: 0 });
    expect(m.evenements.filter((e) => e.label === "Libéré : son agent n'est plus actif")).toHaveLength(6);
  });

  it('deux serveurs répartissent la même campagne en même temps : chaque contact est confié et journalisé une fois', async () => {
    const sansAgent = inactifs(4, { campaign_id: 'C1' });
    const m = monter({
      campagnes: [campagne('C1', { status: 'ACTIVE', lead_agent_id: PILOTE.id, started_at: ilYA(5) })],
      equipes: equipe('C1', AWA, YAO),
      contacts: sansAgent,
      membres: sansAgent.map((c) => ({ campaign_id: 'C1', contact_id: c.id, agent_id: null, released_at: null, segment: 'INACTIF', cycle: 1 })),
    });
    // Les deux lisent la campagne avant que l'un d'eux écrive.
    const [a, b] = await Promise.all([m.service.distribuer(null, 'C1', {}), m.service.distribuer(null, 'C1', {})]);
    expect(a.repartis + b.repartis).toBe(4);
    expect(m.evenements.filter((e) => e.label === 'Réparti automatiquement dans la campagne')).toHaveLength(4);
    expect(m.contactsDe(AWA, 'C1').length + m.contactsDe(YAO, 'C1').length).toBe(4);
    for (const x of m.membres) expect(x.agent_id).toBe(m.contacts.find((c) => c.id === x.contact_id)!.assigned_to_id);
  });

  it('un agent passé à un rôle qui ne traite plus de contacts est traité comme parti', async () => {
    const inscrit = contact({ segment: 'JAMAIS_COMMANDE', assigned_to_id: MARKETING.id });
    const m = monter({ contacts: [inscrit] });
    expect((await m.service.libererAgentsPartis()).liberes).toBe(1);
    expect(m.contacts[0].assigned_to_id).toBeNull();
  });
});

describe('Clôture : un inscrit ou un inactif libéré passe « à reprendre » (problème 8)', () => {
  it('le journal le dit ; le Glovo garde son libellé', async () => {
    const inactif = contact({ segment: 'INACTIF', campaign_id: 'C1', assigned_to_id: AWA.id });
    const glovo = contact({ segment: 'GLOVO', campaign_id: 'C1', assigned_to_id: AWA.id });
    const m = monter({
      campagnes: [campagne('C1', { status: 'ACTIVE', lead_agent_id: PILOTE.id, started_at: ilYA(5) })],
      contacts: [inactif, glovo],
      membres: [inactif, glovo].map((c) => ({ campaign_id: 'C1', contact_id: c.id, agent_id: AWA.id, released_at: null, segment: c.segment, cycle: 1 })),
    });
    await m.service.terminer(DIRECTION, 'C1');
    const libelle = (id: string) => m.evenements.find((e) => e.contact_id === id && e.type === 'CAMPAGNE_SORTIE')?.label;
    expect(libelle(inactif.id)).toBe('Fin de la campagne « Campagne C1 » : libéré, à reprendre');
    expect(libelle(glovo.id)).toBe('Fin de la campagne « Campagne C1 » : libéré, retour dans la file commune');
  });
});

describe('Estimation avant lancement (problème 18)', () => {
  it('un membre de l’équipe passé au marketing ne compte plus : son contact n’est pas annoncé disponible', async () => {
    const m = monter({
      contacts: [contact({ segment: 'INACTIF', assigned_to_id: MARKETING.id }), contact({ segment: 'INACTIF' })],
    });
    const r = await m.service.apercu({ publics: [{ segment: 'INACTIF' }], agent_ids: [AWA.id, MARKETING.id] });
    expect(r.disponibles).toBe(1);
    expect(r.publics[0].exclus.agent_hors_equipe).toBe(1);
  });
});
