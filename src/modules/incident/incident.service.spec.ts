import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { User } from '@prisma/client';
import { COMPTES, Ligne, jeuIncidents } from './incident-base-simulee-spec';
import { IncidentRetardTask } from './incident-retard.task';
import { IncidentService, masquerCode } from './incident.service';

/* eslint-disable @typescript-eslint/no-explicit-any */

const MAINTENANT = new Date('2026-11-11T12:00:00.000Z');
const compte = (c: Ligne) => c as unknown as User;
const heures = (h: number) => new Date(MAINTENANT.getTime() + h * 3_600_000);

let n = 0;
const incident = (plus: Ligne = {}): Ligne => {
  n++;
  return {
    id: `i-${n}`,
    code: `INC-261111-${String(n).padStart(3, '0')}`,
    statut: 'OUVERT',
    gravite: 'MOYENNE',
    origine: 'APPEL',
    categorie_id: 'cat-qualite',
    description: 'Poulet servi tiède.',
    order_id: 'commande-1',
    restaurant_id: 'resto-1',
    customer_id: 'client-1',
    pole: 'RESTAURANT',
    echeance_at: heures(12),
    // La veille à 23 h : hors de la journée du 11/11.
    created_at: heures(-13),
    ...plus,
  };
};

function monter(incidents: Ligne[], plus: Parameters<typeof jeuIncidents>[0] = {}) {
  const base = jeuIncidents({ incidents, ...plus });
  const settings = { getMany: jest.fn(async () => ({})) };
  const service = new IncidentService(base.prisma as any, settings as any);
  return { base, service };
}

beforeEach(() => {
  n = 0;
});

describe('incidents : tableau et compteurs', () => {
  const jeu = () => [
    incident({ id: 'ouvert-faible', gravite: 'FAIBLE' }),
    incident({ id: 'ouvert-haute', gravite: 'HAUTE', created_at: heures(-1) }),
    incident({ id: 'ouvert-retard', gravite: 'FAIBLE', echeance_at: heures(-2) }),
    incident({ id: 'en-cours', statut: 'EN_COURS', agent_id: 'u-cc' }),
    incident({ id: 'resolu-recent', statut: 'RESOLU', resolu_at: heures(-1) }),
    incident({ id: 'resolu-ancien', statut: 'RESOLU', resolu_at: heures(-20) }),
    incident({ id: 'cloture-hier', statut: 'CLOTURE', cloture_at: heures(-24) }),
    incident({ id: 'cloture-vieux', statut: 'CLOTURE', cloture_at: heures(-24 * 9) }),
    incident({ id: 'faya', order_id: 'commande-2', restaurant_id: 'resto-2', customer_id: 'client-2', categorie_id: 'cat-retard', pole: 'LIVRAISON' }),
  ];

  it('range les incidents en quatre colonnes, les plus pressés en tête', async () => {
    const { service } = monter(jeu());
    const { colonnes } = await service.tableau({}, compte(COMPTES.callCenter), MAINTENANT);
    expect(colonnes.OUVERT.incidents.map((i) => i.id)).toEqual(['ouvert-retard', 'ouvert-haute', 'faya', 'ouvert-faible']);
    expect(colonnes.OUVERT.total).toBe(4);
    expect(colonnes.OUVERT.incidents[0].en_retard).toBe(true);
    expect(colonnes.EN_COURS.incidents.map((i) => i.id)).toEqual(['en-cours']);
    expect(colonnes.EN_COURS.incidents[0].agent).toEqual({ id: 'u-cc', fullname: 'Ruth Fetai' });
    // Résolus : celui qui attend sa clôture depuis le plus longtemps d'abord.
    expect(colonnes.RESOLU.incidents.map((i) => i.id)).toEqual(['resolu-ancien', 'resolu-recent']);
    // Clôturés : les sept derniers jours seulement.
    expect(colonnes.CLOTURE.incidents.map((i) => i.id)).toEqual(['cloture-hier']);
    expect(colonnes.CLOTURE.total).toBe(1);
  });

  it("un compte de restaurant ne voit que son restaurant, même s'il demande un autre", async () => {
    const { service } = monter(jeu());
    const { colonnes } = await service.tableau({ restaurantId: 'resto-2' }, compte(COMPTES.manager), MAINTENANT);
    expect(colonnes.OUVERT.incidents.map((i) => i.id)).not.toContain('faya');
    expect(colonnes.OUVERT.total).toBe(3);
    const faya = await service.tableau({}, compte(COMPTES.managerFaya), MAINTENANT);
    expect(faya.colonnes.OUVERT.incidents.map((i) => i.id)).toEqual(['faya']);
  });

  it('filtre par responsable, catégorie, gravité, restaurant', async () => {
    const { service } = monter(jeu());
    const cc = compte(COMPTES.callCenter);
    expect((await service.tableau({ pole: 'LIVRAISON' as any }, cc, MAINTENANT)).colonnes.OUVERT.incidents.map((i) => i.id)).toEqual(['faya']);
    expect((await service.tableau({ gravite: 'HAUTE' as any }, cc, MAINTENANT)).colonnes.OUVERT.incidents.map((i) => i.id)).toEqual(['ouvert-haute']);
    expect((await service.tableau({ restaurantId: 'resto-2' }, cc, MAINTENANT)).colonnes.OUVERT.total).toBe(1);
    expect((await service.tableau({ categorieId: 'cat-retard' }, cc, MAINTENANT)).colonnes.OUVERT.total).toBe(1);
  });

  it('cherche par code, référence, nom ou numéro ; le marketing ne cherche pas par numéro', async () => {
    const { service } = monter(jeu());
    const cc = compte(COMPTES.callCenter);
    const ids = async (recherche: string, u = cc) => {
      const { data } = await service.liste({ recherche, limit: 50 } as any, u, MAINTENANT);
      return data.map((i) => i.id).sort();
    };
    expect(await ids('50951')).toEqual(['faya']);
    expect(await ids('koné')).toHaveLength(8);
    expect(await ids('Mme Koffi')).toEqual(['faya']);
    expect(await ids('05 05 00 00 02')).toEqual(['faya']);
    expect(await ids('INC-261111-002')).toEqual(['ouvert-haute']);
    expect(await ids('05 05 00 00 02', compte(COMPTES.marketing))).toEqual([]);
  });

  it('compte les ouverts, en cours, résolus et en retard', async () => {
    const { service } = monter(jeu());
    expect(await service.compteurs(compte(COMPTES.callCenter), undefined, MAINTENANT)).toEqual({ ouverts: 4, en_cours: 1, resolus: 2, en_retard: 1 });
    expect(await service.compteurs(compte(COMPTES.managerFaya), undefined, MAINTENANT)).toEqual({ ouverts: 1, en_cours: 0, resolus: 0, en_retard: 0 });
  });

  it("l'historique se pagine et se borne à une période", async () => {
    const { service } = monter(jeu());
    const page = await service.liste({ page: 2, limit: 4 } as any, compte(COMPTES.admin), MAINTENANT);
    expect(page.meta).toEqual({ total: 9, page: 2, limit: 4, totalPages: 3 });
    expect(page.data).toHaveLength(4);
    const jour = await service.liste({ du: '2026-11-11', au: '2026-11-11', limit: 50 } as any, compte(COMPTES.admin), MAINTENANT);
    expect(jour.data.map((i) => i.id)).toEqual(['ouvert-haute']);
    const clotures = await service.liste({ statut: 'CLOTURE', limit: 50 } as any, compte(COMPTES.admin), MAINTENANT);
    expect(clotures.data.map((i) => i.id).sort()).toEqual(['cloture-hier', 'cloture-vieux']);
    // Fiche d'un client dans le CRM : ses incidents, dans le restaurant du compte.
    const duClient = await service.liste({ customerId: 'client-2', limit: 50 } as any, compte(COMPTES.admin), MAINTENANT);
    expect(duClient.data.map((i) => i.id)).toEqual(['faya']);
    expect((await service.liste({ customerId: 'client-2', limit: 50 } as any, compte(COMPTES.manager), MAINTENANT)).data).toEqual([]);
  });

  it('les étiquettes des commandes : seulement les incidents non clôturés', async () => {
    const { service } = monter(jeu());
    const ouverts = await service.ouverts(compte(COMPTES.callCenter));
    expect(ouverts).toHaveLength(7);
    expect(ouverts.find((o) => o.id === 'faya')).toEqual({
      id: 'faya',
      code: expect.any(String),
      order_id: 'commande-2',
      statut: 'OUVERT',
      gravite: 'MOYENNE',
      categorie: 'Livraison tardive',
    });
    expect(await service.ouverts(compte(COMPTES.caissier), 'resto-2')).toHaveLength(6);
  });

  it("le tableau de bord porte sur la période et le restaurant du compte", async () => {
    const { service } = monter(jeu());
    const tout = await service.statistiques({ du: '2026-11-01', au: '2026-11-11' }, compte(COMPTES.admin), MAINTENANT);
    expect(tout).toMatchObject({ total: 9, ouverts: 4, en_cours: 1, resolus: 2, clotures: 2, en_retard: 1 });
    const angre = await service.statistiques({ du: '2026-11-01', au: '2026-11-11', restaurantId: 'resto-2' }, compte(COMPTES.manager), MAINTENANT);
    expect(angre.total).toBe(8);
    expect(angre.par_restaurant.map((r) => r.name)).toEqual(['Angré']);
    await expect(service.statistiques({ du: '2024-01-01', au: '2026-11-11' }, compte(COMPTES.admin), MAINTENANT)).rejects.toThrow();
  });

  it("l'export reprend les filtres et écrit les mots de l'écran", async () => {
    const { service } = monter(jeu());
    const fichier = await service.exporter({ pole: 'LIVRAISON' as any }, compte(COMPTES.callCenter));
    const lignes = fichier.contenu.toString('utf8').trim().split('\r\n');
    expect(lignes).toHaveLength(2);
    expect(lignes[1]).toContain('"Livraison tardive";"Moyenne";"Appel";"Livraison";"Faya";"ORD-261110-50951";"Mme Koffi"');
  });
});

describe('incidents : commandes', () => {
  it("les incidents d'une commande, et le droit de signaler", async () => {
    const { service } = monter([incident({ id: 'un' }), incident({ id: 'deux', statut: 'CLOTURE', created_at: heures(-30) })]);
    const reponse = await service.parCommande('commande-1', compte(COMPTES.caissier), MAINTENANT);
    expect(reponse.commande).toMatchObject({ reference: 'ORD-261110-50950', montant: 5500, client: { nom: 'Awa Koné' } });
    expect(reponse.incidents.map((i) => i.id)).toEqual(['un', 'deux']);
    expect(reponse.peut_signaler).toBe(true);
    expect((await service.parCommande('commande-1', compte(COMPTES.marketing), MAINTENANT)).peut_signaler).toBe(false);
  });

  it("refuse la commande d'un autre restaurant et celle qui n'existe pas", async () => {
    const { service } = monter([]);
    await expect(service.parCommande('commande-2', compte(COMPTES.caissier), MAINTENANT)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.parCommande('inconnue', compte(COMPTES.admin), MAINTENANT)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('cherche une commande récente par référence, nom ou numéro, dans le restaurant du compte', async () => {
    const { service } = monter([]);
    const cc = compte(COMPTES.callCenter);
    expect((await service.chercherCommandes('50950', cc, MAINTENANT)).map((c) => c.reference)).toEqual(['ORD-261110-50950']);
    expect((await service.chercherCommandes('0707000001', cc, MAINTENANT)).map((c) => c.id)).toEqual(['commande-1', 'commande-3']);
    expect((await service.chercherCommandes('koffi', cc, MAINTENANT)).map((c) => c.id)).toEqual(['commande-2']);
    expect(await service.chercherCommandes('koffi', compte(COMPTES.caissier), MAINTENANT)).toEqual([]);
    expect(await service.chercherCommandes('k', cc, MAINTENANT)).toEqual([]);
    // Au-delà de soixante jours, la commande n'est plus proposée.
    const plusTard = new Date('2027-02-01T00:00:00.000Z');
    expect(await service.chercherCommandes('50950', cc, plusTard)).toEqual([]);
  });
});

describe('incidents : fiche', () => {
  const avecBon = () =>
    monter(
      [
        incident({ id: 'principal', statut: 'RESOLU', geste: 'BON', bon_montant: 2000, voucher_id: 'bon-1', resolu_at: heures(-1) }),
        incident({ id: 'autre', order_id: 'commande-3', statut: 'CLOTURE', categorie_id: 'cat-retard', created_at: heures(-48) }),
      ],
      { vouchers: [{ id: 'bon-1', code: 'CN7Q2KXP', initial_amount: 2000, status: 'ACTIVE', expires_at: heures(24 * 30) }] },
    );

  it('montre le code du bon à qui traite, le masque aux autres, journal compris', async () => {
    const { service, base } = avecBon();
    await base.prisma.incidentSuivi.create({
      data: { incident_id: 'principal', type: 'BON', meta: { code: 'CN7Q2KXP', montant: 2000, expire: '11/12/2026' }, auteur_nom: 'Ruth Fetai' },
    });
    const traite = await service.fiche('principal', compte(COMPTES.callCenter), MAINTENANT);
    expect(traite.bon).toMatchObject({ code: 'CN7Q2KXP', montant: 2000, statut: 'ACTIVE' });
    expect(traite.suivis[0].texte).toContain('Bon CN7Q2KXP de 2 000 F');
    expect(traite.droits).toMatchObject({ cloturer: true, rouvrir: true, resoudre: false });

    for (const lecteur of [COMPTES.caissier, COMPTES.marketing, COMPTES.livraisonOps]) {
      const lue = await service.fiche('principal', compte(lecteur), MAINTENANT);
      expect(lue.bon?.code).toBe('••••XP');
      expect(JSON.stringify(lue)).not.toContain('CN7Q2KXP');
    }
    // Le manager du restaurant traite cet incident (pôle restaurant) : il lit le code.
    expect((await service.fiche('principal', compte(COMPTES.manager), MAINTENANT)).bon?.code).toBe('CN7Q2KXP');
    expect(masquerCode('AB')).toBe('••');
  });

  it('liste les autres incidents du client et le barème', async () => {
    const { service } = avecBon();
    const fiche = await service.fiche('principal', compte(COMPTES.callCenter), MAINTENANT);
    expect(fiche.autres).toEqual([
      { id: 'autre', code: expect.any(String), statut: 'CLOTURE', categorie: 'Livraison tardive', created_at: heures(-48) },
    ]);
    expect(fiche.montants_bon).toEqual([1000, 2000, 3000]);
    expect(fiche.bon_suggere).toBe(2000);
    expect(fiche.bon_a_creer).toBe(false);
  });

  it("refuse la fiche d'un autre restaurant et celle qui n'existe pas", async () => {
    const { service } = avecBon();
    await expect(service.fiche('principal', compte(COMPTES.managerFaya), MAINTENANT)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.fiche('inconnu', compte(COMPTES.admin), MAINTENANT)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('incidents : délai dépassé', () => {
  const monterTache = (incidents: Ligne[]) => {
    const base = jeuIncidents({ incidents });
    const alertes = { retard: jest.fn(async () => 2), diffuser: jest.fn() };
    return { base, alertes, tache: new IncidentRetardTask(base.prisma as any, alertes as any) };
  };

  it('sonne une fois pour un incident en retard, jamais pour un incident résolu ou dans les délais', async () => {
    const { base, alertes, tache } = monterTache([
      incident({ id: 'retard', echeance_at: heures(-1) }),
      incident({ id: 'en-cours-retard', statut: 'EN_COURS', echeance_at: heures(-3) }),
      incident({ id: 'resolu', statut: 'RESOLU', echeance_at: heures(-1) }),
      incident({ id: 'a-temps', echeance_at: heures(2) }),
    ]);
    expect(await tache.passage(MAINTENANT)).toEqual(['en-cours-retard', 'retard']);
    expect(alertes.retard).toHaveBeenCalledTimes(2);
    expect(base.incident('retard').alerte_retard_at).toEqual(MAINTENANT);
    expect(base.suivis('retard').map((s) => s.type)).toEqual(['RETARD']);
    // Second passage : plus rien à signaler.
    expect(await tache.passage(heures(1))).toEqual([]);
    expect(alertes.retard).toHaveBeenCalledTimes(2);
  });

  it('deux serveurs au même instant : une seule alerte par incident', async () => {
    const { alertes, tache } = monterTache([incident({ id: 'retard', echeance_at: heures(-1) })]);
    const [a, b] = await Promise.all([tache.passage(MAINTENANT), tache.passage(MAINTENANT)]);
    expect([...a, ...b]).toEqual(['retard']);
    expect(alertes.retard).toHaveBeenCalledTimes(1);
  });

  it("personne à prévenir : pas de ligne au journal, et l'incident n'est pas resonné", async () => {
    const { base, alertes, tache } = monterTache([incident({ id: 'retard', echeance_at: heures(-1) })]);
    alertes.retard.mockResolvedValueOnce(0);
    await tache.passage(MAINTENANT);
    expect(base.suivis('retard')).toHaveLength(0);
    expect(await tache.passage(heures(1))).toEqual([]);
  });
});
