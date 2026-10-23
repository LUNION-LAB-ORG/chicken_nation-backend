/**
 * Fin de préparation estimée (conception 3.2) : la cuisine d'abord, la
 * statistique du restaurant par tranche horaire ensuite (assez de mesures,
 * filtres 60 s et 60 min), les défauts enfin ; commande en retard.
 */
import { OrderStatus } from '@prisma/client';

import {
  dureeRetenue,
  ecartEstimationMinutes,
  estimerFinPreparation,
  lireReglagesPreparation,
  MesurePreparation,
  quantile,
  REGLAGES_PREPARATION_DEFAUT,
  statistiqueDesDurees,
  statistiquesParTranche,
  trancheHoraire,
} from './preparation.rules';

const h = (hhmm: string) => new Date(`2026-10-23T${hhmm.length === 5 ? `${hhmm}:00` : hhmm}.000Z`);
const plusMin = (d: Date, min: number) => new Date(d.getTime() + min * 60_000);

/** `n` mesures commencées à `debut` (jours précédents), durées en minutes données en boucle. */
function mesures(debut: string, n: number, dureesMin: number[]): MesurePreparation[] {
  return Array.from({ length: n }, (_, i) => {
    const prepared_at = new Date(h(debut).getTime() - (i + 1) * 24 * 3600_000);
    return { prepared_at, ready_at: plusMin(prepared_at, dureesMin[i % dureesMin.length]) };
  });
}

describe('tranches horaires (heure d’Abidjan = UTC)', () => {
  it.each([
    ['11:00', 'MIDI'],
    ['14:59', 'MIDI'],
    ['15:00', 'APRES_MIDI'],
    ['17:59', 'APRES_MIDI'],
    ['18:00', 'SOIR'],
    ['22:59', 'SOIR'],
    ['23:00', 'AUTRE'],
    ['08:30', 'AUTRE'],
  ])('%s → %s', (heure, tranche) => {
    expect(trancheHoraire(h(heure))).toBe(tranche);
  });
});

describe('mesures retenues pour la statistique', () => {
  it('écarte les clics d’affilée (moins de 60 s) et les oublis (plus de 60 min)', () => {
    const debut = h('12:00');
    expect(dureeRetenue({ prepared_at: debut, ready_at: new Date(debut.getTime() + 30_000) })).toBeNull();
    expect(dureeRetenue({ prepared_at: debut, ready_at: new Date(debut.getTime() + 60_000) })).toBe(60);
    expect(dureeRetenue({ prepared_at: debut, ready_at: plusMin(debut, 60) })).toBe(3600);
    expect(dureeRetenue({ prepared_at: debut, ready_at: plusMin(debut, 61) })).toBeNull();
    expect(dureeRetenue({ prepared_at: debut, ready_at: plusMin(debut, -5) })).toBeNull();
  });

  it('quantile par interpolation linéaire', () => {
    expect(quantile([], 0.5)).toBeNull();
    expect(quantile([10], 0.8)).toBe(10);
    expect(quantile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(quantile([5, 1, 4, 2, 3], 0.8)).toBeCloseTo(4.2);
  });

  it('pas de statistique sous 20 mesures', () => {
    expect(statistiqueDesDurees(Array(19).fill(600))).toBeNull();
    expect(statistiqueDesDurees(Array(20).fill(600))).toEqual({ medianeS: 600, p80S: 600, mesures: 20 });
  });

  it('une statistique par tranche, mesures hors bornes exclues avant le compte', () => {
    const midi = mesures('12:00', 25, [10, 12, 14, 16, 20]);
    const soirTropPeu = mesures('19:00', 15, [8]);
    const clics = mesures('12:30', 10, [0.5]); // écartées : ne comptent pas
    const stats = statistiquesParTranche([...midi, ...soirTropPeu, ...clics]);
    expect(stats.MIDI).not.toBeNull();
    expect(stats.MIDI!.mesures).toBe(25);
    expect(stats.MIDI!.medianeS).toBe(14 * 60);
    expect(stats.MIDI!.p80S).toBeGreaterThan(stats.MIDI!.medianeS);
    expect(stats.SOIR).toBeNull();
    expect(stats.APRES_MIDI).toBeNull();
  });
});

describe('estimation de la fin de préparation', () => {
  const maintenant = h('12:30');
  const enPreparation = (prepared_at: Date | null, estimated_preparation_time: Date | null = null) => ({
    status: OrderStatus.IN_PROGRESS,
    prepared_at,
    estimated_preparation_time,
  });
  const statsMidi = statistiquesParTranche(mesures('12:00', 30, [10, 12, 14, 16, 20]));

  it('seules les commandes EN PRÉPARATION ont une estimation', () => {
    for (const status of [OrderStatus.ACCEPTED, OrderStatus.PENDING, OrderStatus.READY]) {
      expect(estimerFinPreparation({ status, prepared_at: h('12:20') }, statsMidi, maintenant)).toBeNull();
    }
  });

  it('1. la durée donnée par la cuisine l’emporte sur la statistique', () => {
    const e = estimerFinPreparation(enPreparation(h('12:24'), h('12:34')), statsMidi, maintenant)!;
    expect(e.source).toBe('CUISINE');
    expect(e.finMediane).toEqual(h('12:34'));
    expect(e.finDecision).toEqual(h('12:34'));
    expect(e.enRetard).toBe(false);
  });

  it('1 bis. une durée de cuisine absurde (avant le début, plus de 2 h) est ignorée', () => {
    expect(estimerFinPreparation(enPreparation(h('12:24'), h('12:20')), statsMidi, maintenant)!.source).toBe('STATISTIQUE');
    expect(estimerFinPreparation(enPreparation(h('12:24'), h('15:00')), statsMidi, maintenant)!.source).toBe('STATISTIQUE');
  });

  it('2. la statistique de la tranche : médiane pour afficher, 8e décile pour décider', () => {
    const e = estimerFinPreparation(enPreparation(h('12:24')), statsMidi, maintenant)!;
    expect(e.source).toBe('STATISTIQUE');
    expect(e.finMediane.getTime()).toBe(h('12:24').getTime() + statsMidi.MIDI!.medianeS * 1000);
    expect(e.finDecision.getTime()).toBe(h('12:24').getTime() + statsMidi.MIDI!.p80S * 1000);
    expect(e.finDecision.getTime()).toBeGreaterThan(e.finMediane.getTime());
  });

  it('2 bis. pas assez de mesures dans la tranche : les défauts', () => {
    const soir = h('19:00');
    const e = estimerFinPreparation(enPreparation(plusMin(soir, -2)), statsMidi, soir)!;
    expect(e.source).toBe('DEFAUT');
  });

  it('3. les défauts : 12 min (médiane) et 18 min (8e décile)', () => {
    const e = estimerFinPreparation(enPreparation(h('12:24')), null, maintenant)!;
    expect(e.source).toBe('DEFAUT');
    expect(e.finMediane).toEqual(h('12:36'));
    expect(e.finDecision).toEqual(h('12:42'));
  });

  it('commande en retard sur son estimation : prête dans 2 min', () => {
    const e = estimerFinPreparation(enPreparation(h('12:00')), null, maintenant)!; // 12:12 et 12:18 dépassées
    expect(e.enRetard).toBe(true);
    expect(e.finMediane).toEqual(h('12:32'));
    expect(e.finDecision).toEqual(h('12:32'));
    const cuisine = estimerFinPreparation(enPreparation(h('12:20'), h('12:29')), null, maintenant)!;
    expect(cuisine.enRetard).toBe(true);
    expect(cuisine.finDecision).toEqual(h('12:32'));
  });

  it('sans heure de passage en préparation : on part de maintenant (prudent)', () => {
    const e = estimerFinPreparation(enPreparation(null), null, maintenant)!;
    expect(e.debut).toEqual(maintenant);
    expect(e.finDecision).toEqual(h('12:48'));
  });

  it('écart entre l’estimation et la réalité, en minutes', () => {
    expect(ecartEstimationMinutes(h('12:41'), h('12:43'))).toBe(2);
    expect(ecartEstimationMinutes(h('12:41'), h('12:40'))).toBe(-1);
  });
});

describe('réglages de préparation', () => {
  it('défauts sans valeur', () => {
    expect(lireReglagesPreparation({})).toEqual({ reglages: REGLAGES_PREPARATION_DEFAUT, refusees: [] });
  });

  it('valeurs lues, 0 et illisible refusés et signalés, 8e décile jamais sous la médiane', () => {
    expect(lireReglagesPreparation({ 'preparation.duree_defaut_min': '10', 'preparation.duree_p80_min': '15' }).reglages).toEqual({
      dureeDefautMin: 10,
      dureeP80Min: 15,
    });
    const lus = lireReglagesPreparation({ 'preparation.duree_defaut_min': '0', 'preparation.duree_p80_min': 'vite' });
    expect(lus.reglages).toEqual(REGLAGES_PREPARATION_DEFAUT);
    expect(lus.refusees.map((x) => x.cle)).toEqual(['preparation.duree_defaut_min', 'preparation.duree_p80_min']);
    expect(lireReglagesPreparation({ 'preparation.duree_defaut_min': '20', 'preparation.duree_p80_min': '15' }).reglages.dureeP80Min).toBe(20);
  });
});
