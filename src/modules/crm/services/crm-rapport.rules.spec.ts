import {
  compter,
  comparer,
  fmtMontant,
  fmtNombre,
  fmtPct,
  fmtVariation,
  libellePrecedente,
  phrasesARetenir,
  taux,
} from './crm-rapport.rules';
import { rapportFictif } from './crm-rapport.fixture';

const FINE = ' ';
const TIRETS = /[–—]/;

describe('comparer : variation muette quand la base ne porte pas le calcul', () => {
  it('compare un décompte avec une base suffisante', () => {
    const c = comparer(212, 189);
    expect(c).toEqual({ valeur: 212, precedent: 189, ecart: 23, variation: 12.2, comparable: true });
  });

  it('refuse un décompte précédent sous 10', () => {
    const c = comparer(32, 4);
    expect(c.comparable).toBe(false);
    expect(c.variation).toBeNull();
    expect(c.ecart).toBe(28);
  });

  it('refuse un précédent à zéro, même pour un montant', () => {
    expect(comparer(133_070, 0, true)).toEqual({ valeur: 133_070, precedent: 0, ecart: 133_070, variation: null, comparable: false, monnaie: true });
  });

  it('accepte un montant dès que le précédent est positif', () => {
    const c = comparer(13_000, 5, true);
    expect(c.comparable).toBe(false);
    expect(comparer(6_000, 5_000, true).variation).toBe(20);
  });

  it('refuse une variation de 1 000 % ou plus', () => {
    expect(comparer(1_100, 100).comparable).toBe(false);
    expect(comparer(1_099, 100).variation).toBe(999);
  });

  it('accepte une baisse', () => {
    expect(comparer(80, 100).variation).toBe(-20);
  });
});

describe('taux', () => {
  it('donne les deux taux et l’écart en points, à 0,1', () => {
    expect(taux(41, 212, 30, 189)).toEqual({ valeur: 19.3, precedent: 15.9, ecart_points: 3.4 });
  });
  it('vaut 0 sans dénominateur', () => {
    expect(taux(0, 0, 3, 0)).toEqual({ valeur: 0, precedent: 0, ecart_points: 0 });
  });
});

describe('formats à la française', () => {
  it('écrit les milliers avec une insécable classique, jamais la fine', () => {
    expect(fmtNombre(133_070)).toBe('133 070');
    expect(fmtNombre(133_070)).not.toContain(FINE);
    expect(fmtMontant(133_070)).toBe('133 070 F');
    expect(fmtPct(19.34)).toBe('19,3 %');
  });
  it('signe la variation avec un moins ordinaire', () => {
    expect(fmtVariation(12)).toBe('+12 %');
    expect(fmtVariation(-8.5)).toBe('-8,5 %');
    expect(fmtVariation(-8.5)).not.toMatch(TIRETS);
  });
  it('accorde le nom', () => {
    expect(compter(1, 'inscrit')).toBe('1 inscrit');
    expect(compter(212, 'inscrit')).toBe('212 inscrits');
    expect(compter(0, 'inscrit')).toBe('0 inscrit');
  });
  it('nomme la période précédente', () => {
    expect(libellePrecedente(7)).toBe('à la semaine précédente');
    expect(libellePrecedente(30)).toBe('au mois précédent');
    expect(libellePrecedente(60)).toBe('aux 60 jours précédents');
    expect(libellePrecedente(1)).toBe('à la veille');
  });
});

describe('phrasesARetenir', () => {
  it('écrit une phrase par levier puis une seule variation, sur un chiffre comparable', () => {
    const phrases = phrasesARetenir(rapportFictif(7));
    expect(phrases).toHaveLength(4);
    expect(phrases[0]).toBe('212 inscrits sur la période, 41 ont déjà commandé (19,3 %).');
    expect(phrases[1]).toBe('Glovo et Yango : 252 clients appelés, 124 joints, 27 passés en direct pour 133 070 F.');
    expect(phrases[2]).toBe('Clients inactifs : 12 clients revenus sur 83 entrés en inactivité.');
    expect(phrases[3]).toMatch(/^Les ventes du CRM sont en hausse de 30 % par rapport à la période précédente \(30 avant\)\.$/);
    for (const s of phrases) {
      expect(s).not.toContain(FINE);
      expect(s).not.toMatch(TIRETS);
      expect(s).not.toMatch(/N\/A/);
    }
  });

  it('se tait sur la variation quand rien n’est comparable', () => {
    const r = rapportFictif(7);
    r.resultat.ventes = comparer(39, 0);
    r.equipe.appels = comparer(347, 3);
    r.inscriptions.inscrits = comparer(212, 0);
    const phrases = phrasesARetenir(r);
    expect(phrases).toHaveLength(3);
    expect(phrases.join(' ')).not.toContain('par rapport');
  });

  it('saute un levier hors du filtre et accorde le singulier', () => {
    const r = rapportFictif(7);
    r.captes.hors_filtre = true;
    r.inscriptions.inscrits = comparer(1, 0);
    r.inscriptions.ont_commande = comparer(1, 0);
    r.inscriptions.taux_commande = taux(1, 1, 0, 0);
    const phrases = phrasesARetenir(r);
    expect(phrases[0]).toBe('1 inscrit sur la période, 1 a déjà commandé (100 %).');
    expect(phrases.some((s) => s.startsWith('Glovo'))).toBe(false);
  });

  it('dit « aucun » plutôt que zéro à l’oral', () => {
    const r = rapportFictif(7);
    r.inscriptions.inscrits = comparer(0, 0);
    r.inscriptions.ont_commande = comparer(0, 0);
    r.inactifs.ventes = comparer(0, 0);
    const phrases = phrasesARetenir(r);
    expect(phrases[0]).toBe('Aucun inscrit sur la période.');
    expect(phrases[2]).toBe('Clients inactifs : aucun client revenu sur 83 entrés en inactivité.');
  });
});
