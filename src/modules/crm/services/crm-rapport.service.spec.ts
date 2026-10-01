import { CrmSegment } from '@prisma/client';
import { BRUT_DEVENIR_VIDE, calculerDevenir } from '../crm.rules';
import { PrismaService } from 'src/database/services/prisma.service';
import { CrmAnalyticsService } from './crm-analytics.service';
import { Activite, CrmPublicsService } from './crm-publics.service';
import { CrmRapportService, construireLevier, parSemaine } from './crm-rapport.service';

const CLES = ['JAMAIS_COMMANDE', 'INACTIF', 'GLOVO', 'YANGO', 'CAPTES', 'TOTAL'] as const;

const activiteVide: Activite = {
  appels: 0,
  appels_joints: 0,
  contacts_appeles: 0,
  contacts_joints: 0,
  coupons_envoyes: 0,
  coupons_utilises: 0,
  ca_coupons: 0,
  remises_coupons: 0,
  ventes_crm: 0,
  ca_crm: 0,
  panier_moyen: 0,
  ventes_historiques: 0,
  ca_historique: 0,
};

const groupes = <T>(fabrique: (cle: string) => T) => Object.fromEntries(CLES.map((c) => [c, fabrique(c)])) as Record<(typeof CLES)[number], T>;

/**
 * Faux services : les entrés et l'activité par public sont donnés tels quels,
 * ce qui se teste ici est l'ASSEMBLAGE (contrat, filtres, périodes, phrases),
 * pas les requêtes, qui ont leurs propres tableaux de bord.
 */
function monter(options: { from?: string; to?: string; segments?: string[]; campaign_id?: string; perimetre_restaurant?: string } = {}) {
  const devenir = jest.fn(async () =>
    groupes((cle) => calculerDevenir({ ...BRUT_DEVENIR_VIDE, entrees: cle === 'INACTIF' ? 83 : cle === 'GLOVO' ? 301 : cle === 'YANGO' ? 178 : cle === 'CAPTES' ? 479 : 0, delai_median_j: 6 }, true)),
  );
  const activite = jest.fn(async (q: { from: string }) => {
    // La période précédente est reconnue à sa date de début.
    const prec = q.from < options.from!;
    return groupes((cle) => ({
      ...activiteVide,
      appels: cle === 'TOTAL' ? (prec ? 318 : 347) : 100,
      contacts_appeles: cle === 'TOTAL' ? (prec ? 300 : 320) : cle === 'CAPTES' ? 252 : 90,
      contacts_joints: cle === 'TOTAL' ? (prec ? 161 : 181) : cle === 'CAPTES' ? 124 : 50,
      coupons_envoyes: cle === 'TOTAL' ? (prec ? 216 : 269) : 60,
      ventes_crm: cle === 'TOTAL' ? (prec ? 21 : 27) : cle === 'CAPTES' ? 27 : cle === 'INACTIF' ? 12 : 5,
      ca_crm: cle === 'CAPTES' ? 133_070 : 50_000,
      panier_moyen: 7_000,
    }));
  });
  const publics = { fenetre: jest.fn(async () => 30), devenir, activite } as unknown as CrmPublicsService;
  const analytics = {
    agents: jest.fn(async () => [{ id: 'a1', fullname: 'Aïcha Diabaté', appels: 51, joints: 28, coupons: 40, ventes: 5, ca: 24_650 }]),
    raisons: jest.fn(async () => ({
      total: 92,
      raisons: Array.from({ length: 8 }, (_, i) => ({ id: `r${i}`, raison: `Raison ${i}`, nombre: 10, part: 10.9 })),
    })),
  } as unknown as CrmAnalyticsService;
  const queryRaw = jest.fn(async (strings: TemplateStringsArray) => {
    const sql = strings.join('?');
    if (sql.includes('generate_series')) return [{ date: options.from, inscrits: 92, premieres_commandes: 9 }];
    if (sql.includes('"Customer"')) return [{ inscrits: 212, ont_commande: 41, sous_7_jours: 29, delai_median_j: 2.5, ca: 318_900 }];
    return [{ premier: null }];
  });
  const prisma = {
    $queryRaw: queryRaw,
    crmCampaign: { findUnique: jest.fn(async () => ({ id: 'c1', name: 'Rentrée' })) },
    restaurant: { findUnique: jest.fn(async () => ({ id: 'r1', name: 'Angré' })) },
  } as unknown as PrismaService;
  const service = new CrmRapportService(prisma, analytics, publics);
  return { service, devenir, activite, queryRaw };
}

describe('CrmRapportService.rapport : assemblage du contrat', () => {
  it('compare la période à la précédente de même durée et remplit chaque section', async () => {
    const { service, activite, queryRaw } = monter({ from: '2026-09-25', to: '2026-10-01' });
    const r = await service.rapport({ from: '2026-09-25', to: '2026-10-01' });

    expect(r.periode).toEqual({ debut: '2026-09-25', fin: '2026-10-01', jours: 7 });
    expect(r.precedente).toEqual({ debut: '2026-09-18', fin: '2026-09-24' });
    expect(activite).toHaveBeenCalledWith(expect.objectContaining({ from: '2026-09-18', to: '2026-09-24' }));
    expect(r.filtres).toEqual({ publics: [], campagne: null, restaurant: null });

    expect(r.inscriptions.hors_filtre).toBe(false);
    expect(r.inscriptions.hors_restaurant).toBe(false);
    expect(r.inscriptions.inscrits.valeur).toBe(212);
    expect(r.inscriptions.taux_commande.valeur).toBe(19.3);
    expect(r.inscriptions.sans_commande).toBe(171);
    expect(r.inscriptions.pas).toBe('jour');
    expect(r.inscriptions.serie).toEqual([{ date: '2026-09-25', inscrits: 92, premieres_commandes: 9 }]);
    // Les inscrits ont leur requête, jamais limitée à un restaurant.
    expect(queryRaw.mock.calls.some(([s]) => s.join('?').includes('"Customer"'))).toBe(true);

    expect(r.captes.hors_filtre).toBe(false);
    expect(r.captes.total.entres.valeur).toBe(479);
    expect(r.captes.total.ventes.valeur).toBe(27);
    expect(r.captes.total.taux_conversion.valeur).toBe(5.6);
    expect(r.captes.par_public.map((p) => p.segment)).toEqual(['GLOVO', 'YANGO']);
    expect(r.captes.par_public[0].entres.valeur).toBe(301);

    expect(r.inactifs.entres.valeur).toBe(83);
    expect(r.inactifs.ventes.valeur).toBe(12);
    expect(r.inactifs.delai_median_j).toBe(6);

    expect(r.equipe.appels).toEqual({ valeur: 347, precedent: 318, ecart: 29, variation: 9.1, comparable: true });
    expect(r.equipe.appeles).toEqual({ valeur: 320, precedent: 300, ecart: 20, variation: 6.7, comparable: true });
    // Le taux de contact se lit sur les clients appelés (320), pas sur les appels (347).
    expect(r.equipe.taux_contact).toEqual({ valeur: 56.6, precedent: 53.7, ecart_points: 2.9 });
    expect(r.equipe.agents).toEqual([{ id: 'a1', nom: 'Aïcha Diabaté', appels: 51, joints: 28, coupons: 40, ventes: 5, ca: 24_650 }]);

    expect(r.resultat.ventes.variation).toBe(28.6);
    expect(r.resultat.ca.monnaie).toBe(true);
    expect(r.resultat.par_public).toHaveLength(4);
    expect(r.raisons).toHaveLength(6);
    expect(r.raisons[0]).toEqual({ raison: 'Raison 0', nombre: 10, part: 10.9 });

    expect(r.a_retenir).toHaveLength(4);
    expect(r.a_retenir[0]).toBe('212 inscrits sur la période, 41 ont déjà commandé (19,3 %).');
  });

  it('met à zéro les sections hors du filtre des publics, sans les retirer', async () => {
    const { service, queryRaw } = monter({ from: '2026-09-25', to: '2026-10-01' });
    const r = await service.rapport({ from: '2026-09-25', to: '2026-10-01', segments: [CrmSegment.GLOVO] });
    expect(r.filtres.publics).toEqual(['GLOVO']);
    expect(r.inscriptions.hors_filtre).toBe(true);
    expect(r.inscriptions.inscrits.valeur).toBe(0);
    expect(queryRaw.mock.calls.some(([s]) => s.join('?').includes('"Customer"'))).toBe(false);
    expect(r.inactifs.hors_filtre).toBe(true);
    expect(r.inactifs.entres.valeur).toBe(0);
    expect(r.captes.hors_filtre).toBe(false);
    expect(r.captes.par_public.find((p) => p.segment === 'YANGO')?.hors_filtre).toBe(true);
    expect(r.captes.par_public.find((p) => p.segment === 'YANGO')?.entres.valeur).toBe(0);
    expect(r.resultat.par_public.map((p) => p.segment)).toEqual(['GLOVO']);
    expect(r.a_retenir.some((s) => s.startsWith('Glovo :'))).toBe(true);
    expect(r.a_retenir.some((s) => s.includes('inscrit'))).toBe(false);
  });

  it('pour un restaurant : inscrits de tout le réseau, nom du restaurant, inscriptions hors campagne', async () => {
    const { service } = monter({ from: '2026-09-25', to: '2026-10-01' });
    const r = await service.rapport({ from: '2026-09-25', to: '2026-10-01', perimetre_restaurant: 'r1' });
    expect(r.filtres.restaurant).toEqual({ id: 'r1', nom: 'Angré' });
    expect(r.inscriptions.hors_restaurant).toBe(true);
    expect(r.inscriptions.hors_filtre).toBe(false);
    expect(r.inscriptions.inscrits.valeur).toBe(212);

    const avecCampagne = await service.rapport({ from: '2026-09-25', to: '2026-10-01', campaign_id: 'c1' });
    expect(avecCampagne.filtres.campagne).toEqual({ id: 'c1', nom: 'Rentrée' });
    expect(avecCampagne.inscriptions.hors_filtre).toBe(true);
  });

  it('passe la courbe par semaine au-delà de 45 jours', async () => {
    const { service } = monter({ from: '2026-08-03', to: '2026-10-01' });
    const r = await service.rapport({ from: '2026-08-03', to: '2026-10-01' });
    expect(r.periode.jours).toBe(60);
    expect(r.precedente).toEqual({ debut: '2026-06-04', fin: '2026-08-02' });
    expect(r.inscriptions.pas).toBe('semaine');
  });
});

describe('construireLevier et parSemaine', () => {
  it('lit le taux de contact sur les appelés et le taux de conversion sur les entrés', () => {
    const d = calculerDevenir({ ...BRUT_DEVENIR_VIDE, entrees: 479 }, true);
    const dp = calculerDevenir({ ...BRUT_DEVENIR_VIDE, entrees: 458 }, true);
    const a = { ...activiteVide, contacts_appeles: 252, contacts_joints: 124, coupons_envoyes: 99, ventes_crm: 27, ca_crm: 133_070 };
    const ap = { ...activiteVide, contacts_appeles: 238, contacts_joints: 117, coupons_envoyes: 88, ventes_crm: 21, ca_crm: 101_200 };
    const l = construireLevier(d, dp, a, ap);
    expect(l.entres.variation).toBe(4.6);
    expect(l.taux_contact).toEqual({ valeur: 49.2, precedent: 49.2, ecart_points: 0 });
    expect(l.taux_conversion).toEqual({ valeur: 5.6, precedent: 4.6, ecart_points: 1 });
    expect(l.ca.monnaie).toBe(true);
  });

  it('regroupe par tranches de 7 jours datées du premier jour', () => {
    const serie = Array.from({ length: 10 }, (_, i) => ({ date: `2026-09-${String(i + 1).padStart(2, '0')}`, inscrits: 1, premieres_commandes: i }));
    expect(parSemaine(serie)).toEqual([
      { date: '2026-09-01', inscrits: 7, premieres_commandes: 21 },
      { date: '2026-09-08', inscrits: 3, premieres_commandes: 24 },
    ]);
  });
});
