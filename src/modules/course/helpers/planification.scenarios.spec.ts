/**
 * Scénarios courts, minute par minute, sur les VRAIES règles du planificateur
 * (`planifier`), dans un petit monde simulé (monde-planification.simulee-spec.ts) :
 * cuisine, livreurs, caisse. Chaque pas de 10 s : événements, planificateur
 * (déclenchement par événement), livreurs et caisse, planificateur (tâche).
 *
 * Le monde contrôle à chaque action : jamais d'offre à un livreur qui ne
 * peut pas la recevoir (pause), jamais d'ajout ni de fusion vers Turbo ou un
 * livreur en pause, jamais plus de 3 commandes, retenue jamais repoussée ni
 * au-delà de la limite, et ZÉRO TEMPS MORT (jamais un livreur libre pendant
 * qu'une course attend sans offre).
 *
 * Restaurant Zone 4 ; clients à l'est (+) ou à l'ouest (−), au nord en mètres.
 */
import { CourseStatut, OrderStatus } from '@prisma/client';

import { FIN_PAUSE_INDEFINIE } from 'src/modules/deliverers/helpers/disponibilite.rules';

import { h, hms, Monde, R } from './monde-planification.simulee-spec';
import { REGLAGES_PLANIFICATION_DEFAUT, ReglagesPlanification } from './planification.rules';

const SANS_TURBO: ReglagesPlanification = { ...REGLAGES_PLANIFICATION_DEFAUT, turboActif: false };
/** Attente courte seule, comme avant le 24/10 : cas du trajet long coupé. */
const COURT: ReglagesPlanification = { ...REGLAGES_PLANIFICATION_DEFAUT, attenteMaxTrajetLongS: 0 };

/** Heures (hh:mm:ss) des actions d'un type. */
const heures = (m: Monde, type: Parameters<Monde['toutes']>[0]) => m.toutes(type).map((x) => hms(x.t));

describe('cas du client (3.9) : un seul livreur, au comptoir ; A prête, B et C en préparation', () => {
  /**
   * D1 libre au comptoir, nouvelle appli ; D2 en tournée loin (retour vers
   * 13 h 06). A (2,5 km est) prête à 12 h 30 ; B (1,5 km est) en préparation
   * depuis 12 h 24 ; C (2 km est) depuis 12 h 27, prête à 12 h 35.
   */
  function monde(finCuisineB: Date | null, delaiDepartS = 120, reglages = REGLAGES_PLANIFICATION_DEFAUT) {
    const m = new Monde(h('12:29:50'), reglages)
      .livreur('d1', { libreDepuis: h('12:00'), delaiDepartS })
      .livreur('d2', { libreDepuis: h('11:00') })
      .commande('z', { nord: 5000, est: 0, creee: h('12:00'), enPreparation: h('12:05'), prete: h('12:20') })
      .courseEnTournee('d2', ['z'], h('12:25'))
      .commande('a', { est: 2500, creee: h('12:18'), enPreparation: h('12:19'), prete: h('12:30') })
      .commande('b', { est: 1500, creee: h('12:20'), enPreparation: h('12:24'), prete: h('12:34'), finCuisine: finCuisineB })
      .commande('c', { est: 2000, creee: h('12:22'), enPreparation: h('12:27'), prete: h('12:35') });
    return m;
  }

  it('B annoncée pour 12 h 34 : A attend B au comptoir, puis C est ajoutée après le retrait, un seul code', () => {
    const m = monde(h('12:34')).jusqua(h('13:05'));

    // 12:30 : course créée tout de suite et offerte à D1 (aucun lot d'attente).
    expect(m.toutes('CREER_COURSE').map((x) => [hms(x.t), x.action.order_ids])).toEqual([['12:30:00', ['a']]]);
    expect(m.toutes('OFFRIR').map((x) => [hms(x.t), x.action.deliverer_id])).toEqual([['12:30:00', 'd1']]);

    // 12:30:10 : D1 accepte, au comptoir ; la course est retenue pour B jusqu'à 12:34 (≤ 12:35 = A + 5 min).
    const retenues = m.toutes('RETENIR');
    expect(retenues).toHaveLength(1);
    expect(hms(retenues[0].t)).toBe('12:30:10');
    expect(retenues[0].action.jusqua).toEqual(h('12:34'));
    expect(retenues[0].action.attendues.map((x) => x.order_id)).toEqual(['b']);
    // C (prête vers 12:45 d'après les défauts) est au-delà de l'horizon. Trajet
    // long (aller-retour de A : 29 min à 16 km/h), mais A arriverait après sa
    // promesse + 5 min en l'attendant : non attendue.
    expect(m.historique.some(({ plan }) => plan.refus.some((r) => r.order_id === 'c' && r.refus === 'RETARD_CLIENT'))).toBe(true);
    expect(m.toutes('RETENIR').every((x) => x.action.motif === 'ATTENTE_COURTE')).toBe(true);

    // 12:34 : B prête, ajoutée dans la seconde ; « Tout est prêt » ; la caisse remet A et B.
    const ajouts = m.toutes('AJOUTER');
    expect(ajouts.map((x) => [hms(x.t), x.action.order_id, x.action.attendue, x.action.apres_retrait])).toEqual([
      ['12:34:00', 'b', true, false],
      ['12:35:00', 'c', false, true], // 12:35 : C prête, D1 encore au comptoir après le retrait
    ]);
    expect(m.toutes('LIBERER').map((x) => [hms(x.t), x.action.motif])).toEqual([['12:34:00', 'TOUT_PRET']]);

    const k = m.courseDe('a')!;
    expect(m.courseDe('b')!.id).toBe(k.id);
    expect(m.courseDe('c')!.id).toBe(k.id);
    expect(hms(m.commandes.get('a')!.remise_at!)).toBe('12:34:00');
    expect(hms(m.commandes.get('b')!.remise_at!)).toBe('12:34:00');
    expect(hms(m.commandes.get('c')!.remise_at!)).toBe('12:35:00');
    expect(k.livraisons.find((x) => x.order_id === 'c')!.ajoutee_apres_retrait).toBe(true);
    expect(hms(k.parti_at!)).toBe('12:36:00');
    // Ordre de la tournée : le plus proche d'abord, sur le trajet.
    expect([...k.livraisons].sort((x, y) => x.sequence_order - y.sequence_order).map((x) => x.order_id)).toEqual(['b', 'c', 'a']);

    // Tout est livré par D1, aucun Turbo, aucune violation (dont zéro temps mort).
    for (const id of ['a', 'b', 'c']) expect(m.commandes.get(id)!.statut).toBe(OrderStatus.COMPLETED);
    expect(m.toutes('CONFIER_TURBO')).toEqual([]);
    expect(m.violations).toEqual([]);
  });

  it('B prête vers 12 h 42 (au-delà de l’horizon) : trajet long, A attend B en passant la première ; tout part avec D1, sans Turbo', () => {
    const m = monde(null).jusqua(h('13:05'));

    // Trajet long (A à 2,5 km, aller-retour de 29 min à 16 km/h). En
    // attendant B jusqu'à 12 h 42, A arriverait après 12 h 58 (promesse +
    // 5 min) si B passait d'abord ; A d'abord, elle arrive vers 12 h 56 et B,
    // qu'aucun autre livreur ne prendrait, la suit (essai du 28/10 : avant,
    // seul l'ordre « B d'abord » était essayé, A partait seule et B et C
    // finissaient chez Turbo).
    expect(m.toutes('RETENIR').map((x) => [hms(x.t), x.action.motif, hms(x.action.jusqua), x.action.attendues.map((a) => a.order_id)])).toEqual([
      ['12:30:10', 'TRAJET_LONG', '12:42:00', ['b']],
    ]);
    // Attente courte seule : B au-delà de l'horizon, comme avant.
    const court = monde(null, 120, COURT).jusqua(h('12:31'));
    expect(court.historique.some(({ plan }) => plan.refus.some((r) => r.order_id === 'b' && r.refus === 'HORIZON'))).toBe(true);

    // B prête à 12:34 : ajoutée, « Tout est prêt », remise avec A ; C ajoutée après le retrait.
    expect(m.toutes('AJOUTER').map((x) => [hms(x.t), x.action.order_id, x.action.apres_retrait])).toEqual([
      ['12:34:00', 'b', false],
      ['12:35:00', 'c', true],
    ]);
    expect(m.toutes('CREER_COURSE').map((x) => [hms(x.t), x.action.order_ids])).toEqual([['12:30:00', ['a']]]);
    const k = m.courseDe('a')!;
    expect(m.courseDe('b')!.id).toBe(k.id);
    expect(m.courseDe('c')!.id).toBe(k.id);
    expect(hms(k.parti_at!)).toBe('12:36:00');
    // Toutes livrées par D1 avant leur promesse + 5 min (A 12:58, B 13:00, C 13:02).
    expect(hms(m.commandes.get('a')!.livree_at!) < '12:58:00').toBe(true);
    expect(hms(m.commandes.get('b')!.livree_at!) < '13:00:00').toBe(true);
    expect(hms(m.commandes.get('c')!.livree_at!) < '13:02:00').toBe(true);
    expect(m.toutes('CONFIER_TURBO')).toEqual([]);
    expect(m.violations).toEqual([]);
  });
});

describe('demande 4 : deux courses prêtes, pas encore affectées, même direction', () => {
  it('fusionnées automatiquement, puis proposées dès qu’un livreur se libère', () => {
    const m = new Monde(h('12:59:50'))
      .livreur('d1', { libreDepuis: null })
      .commande('a', { est: 2000, creee: h('12:40'), enPreparation: h('12:45'), prete: h('12:58') })
      .commande('b', { est: 2400, nord: 200, creee: h('12:45'), enPreparation: h('12:48'), prete: h('12:59') })
      .courseExistante('KA', ['a'], { creee: h('12:58') })
      .courseExistante('KB', ['b'], { creee: h('12:59') });
    m.prevoir(h('13:03'), () => m.reprendre('d1'));
    m.jusqua(h('13:40'));

    expect(m.toutes('FUSIONNER').map((x) => [hms(x.t), x.action.cible_id, x.action.absorbee_id, x.action.motif])).toEqual([
      ['13:00:00', 'KA', 'KB', 'MEME_ZONE'],
    ]);
    expect(m.courses.get('KB')!.statut).toBe(CourseStatut.CANCELLED);
    // Personne avant 13:03 ; à 13:03, D1 revient : la course fusionnée lui est proposée dans la seconde.
    expect(m.toutes('OFFRIR').map((x) => [hms(x.t), x.action.course_id, x.action.deliverer_id])).toEqual([['13:03:00', 'KA', 'd1']]);
    expect(m.toutes('CONFIER_TURBO')).toEqual([]);
    expect(m.courses.get('KA')!.deliverer_id).toBe('d1');
    for (const id of ['a', 'b']) expect(m.commandes.get(id)!.statut).toBe(OrderStatus.COMPLETED);
    expect(m.violations).toEqual([]);
  });

  it('sens opposés : jamais fusionnées, chacune au premier livreur qui se libère, la plus urgente d’abord', () => {
    const m = new Monde(h('12:59:50'), SANS_TURBO)
      .livreur('d1', { libreDepuis: null })
      .livreur('d2', { libreDepuis: null })
      .commande('a', { est: 2000, creee: h('12:40'), enPreparation: h('12:45'), prete: h('12:58') })
      .commande('b', { est: -2000, creee: h('12:45'), enPreparation: h('12:48'), prete: h('12:59') })
      .courseExistante('KA', ['a'], { creee: h('12:58') })
      .courseExistante('KB', ['b'], { creee: h('12:59') });
    m.prevoir(h('13:03'), () => m.reprendre('d1'));
    m.prevoir(h('13:05'), () => m.reprendre('d2'));
    m.jusqua(h('13:40'));

    expect(m.toutes('FUSIONNER')).toEqual([]);
    expect(m.historique.some(({ plan }) => plan.refus.some((r) => r.essai === 'FUSION' && r.refus === 'DIRECTION'))).toBe(true);
    expect(m.toutes('OFFRIR').map((x) => [hms(x.t), x.action.course_id, x.action.deliverer_id])).toEqual([
      ['13:03:00', 'KA', 'd1'],
      ['13:05:00', 'KB', 'd2'],
    ]);
    for (const id of ['a', 'b']) expect(m.commandes.get(id)!.statut).toBe(OrderStatus.COMPLETED);
    expect(m.violations).toEqual([]);
  });
});

describe('une commande prête n’est jamais retenue au-delà de la limite', () => {
  it('B annoncée pour 12 h 34 min 30 mais en retard : la retenue tombe à l’échéance, A part sans elle', () => {
    const m = new Monde(h('12:29:50'))
      .livreur('d1', { libreDepuis: h('12:00'), delaiDepartS: 30 })
      .commande('a', { est: 2500, creee: h('12:18'), enPreparation: h('12:19'), prete: h('12:30') })
      .commande('b', { est: 2000, creee: h('12:20'), enPreparation: h('12:24'), prete: h('12:38'), finCuisine: h('12:34:30') });
    m.jusqua(h('12:50'));

    expect(m.toutes('RETENIR').map((x) => [hms(x.t), hms(x.action.jusqua)])).toEqual([['12:30:10', '12:34:30']]);
    expect(m.toutes('LIBERER').map((x) => [hms(x.t), x.action.motif])).toEqual([['12:34:30', 'ECHEANCE']]);
    // Jamais au-delà de ready_at(A) + 5 min, jamais repoussée (contrôlé à chaque action par le monde).
    for (const r of m.retenuesVues) expect(r.jusqua.getTime()).toBeLessThanOrEqual(h('12:35').getTime());
    expect(hms(m.commandes.get('a')!.remise_at!)).toBe('12:34:30');
    expect(m.courseDe('b')!.id).not.toBe(m.courseDe('a')!.id);
    expect(m.violations).toEqual([]);
  });

  const apresLaLimite = (r: ReglagesPlanification) =>
    new Monde(h('12:29:50'), r)
      .livreur('d1', { libreDepuis: h('12:00'), delaiDepartS: 30 })
      .commande('a', { est: 2500, creee: h('12:18'), enPreparation: h('12:19'), prete: h('12:30') })
      .commande('b', { est: 2000, creee: h('12:20'), enPreparation: h('12:24'), prete: h('12:36'), finCuisine: h('12:36') });

  it('attente courte : B annoncée après la limite, aucune retenue, A remise aussitôt', () => {
    const m = apresLaLimite(COURT).jusqua(h('12:40'));

    expect(m.toutes('RETENIR')).toEqual([]);
    expect(m.historique.some(({ plan }) => plan.refus.some((r) => r.order_id === 'b' && r.refus === 'LIMITE_RETENUE'))).toBe(true);
    expect(hms(m.commandes.get('a')!.remise_at!)).toBe('12:30:30');
    expect(m.violations).toEqual([]);
  });

  it('trajet long : la même B (6 min) est attendue, A et B partent ensemble ; jamais au-delà de ready_at + 20 min', () => {
    // A à 2,5 km : aller-retour de 29 min à 16 km/h, bien plus que 6 min + 5.
    const m = apresLaLimite(REGLAGES_PLANIFICATION_DEFAUT).jusqua(h('12:40'));

    expect(m.toutes('RETENIR').map((x) => [hms(x.t), hms(x.action.jusqua), x.action.motif])).toEqual([
      ['12:30:10', '12:36:00', 'TRAJET_LONG'],
    ]);
    expect(m.toutes('LIBERER').map((x) => [hms(x.t), x.action.motif])).toEqual([['12:36:00', 'TOUT_PRET']]);
    expect(m.courseDe('b')!.id).toBe(m.courseDe('a')!.id);
    expect(hms(m.commandes.get('a')!.remise_at!)).toBe('12:36:00');
    for (const r of m.retenuesVues) expect(r.jusqua.getTime()).toBeLessThanOrEqual(h('12:50').getTime());
    expect(m.violations).toEqual([]);
  });
});

describe('trajet long (demande du 24/10) : attendre toute la préparation si le livreur reviendrait tard', () => {
  /**
   * Restaurant Zone 4, 15 h 30 (22 km/h). Un seul livreur, D1, libre au
   * comptoir. A prête à 15 h 28 (créée à 15 h 20) ; B, même direction à
   * 5,5 km à l'est, en préparation depuis 15 h 28, la cuisine l'annonce pour
   * 15 h 40 : prête dans 12 min.
   */
  const scene = (estA: number, r: ReglagesPlanification = REGLAGES_PLANIFICATION_DEFAUT) =>
    new Monde(h('15:27:50'), r)
      .livreur('d1', { libreDepuis: h('15:00'), delaiDepartS: 30 })
      .commande('a', { est: estA, creee: h('15:20'), enPreparation: h('15:21'), prete: h('15:28') })
      .commande('b', { est: 5500, creee: h('15:25'), enPreparation: h('15:28'), prete: h('15:40'), finCuisine: h('15:40') });

  /** Délai de chaque client, de la commande à la remise chez lui (minutes), et leur somme. */
  const delais = (m: Monde) => {
    const delai = (id: string) => {
      const c = m.commandes.get(id)!;
      return (c.livree_at!.getTime() - c.created_at.getTime()) / 60_000;
    };
    return { a: delai('a'), b: delai('b'), total: delai('a') + delai('b') };
  };
  const SANS_TURBO_COURT: ReglagesPlanification = { ...SANS_TURBO, attenteMaxTrajetLongS: 0 };

  it('A à 7 km (aller-retour de 41 min) : A attend B au comptoir, ils partent ensemble', () => {
    const m = scene(5000).jusqua(h('16:15'));

    // 15:28 : course de A créée et proposée à D1, acceptée au comptoir à 15:28:10.
    expect(m.toutes('CREER_COURSE').map((x) => [hms(x.t), x.action.order_ids])).toEqual([['15:28:00', ['a']]]);
    // 15:28:10 : partir seul le ferait revenir vers 16:09, 29 min après B : trajet long, A attend B jusqu'à 15:40.
    expect(m.toutes('RETENIR').map((x) => [hms(x.t), hms(x.action.jusqua), x.action.motif, x.action.libelle])).toEqual([
      ['15:28:10', '15:40:00', 'TRAJET_LONG', 'Trajet long : attendre CMD-B (prête vers 15 h 40), départ au plus tard 15 h 40'],
    ]);
    expect(m.toutes('RETENIR')[0].action.aller_retour_s! / 60).toBeCloseTo(41.2, 1);
    // 15:40 : B prête, ajoutée dans la seconde, « Tout est prêt », A et B remises ensemble, départ à 15:40:30.
    expect(m.toutes('AJOUTER').map((x) => [hms(x.t), x.action.order_id, x.action.attendue])).toEqual([['15:40:00', 'b', true]]);
    expect(m.toutes('LIBERER').map((x) => [hms(x.t), x.action.motif])).toEqual([['15:40:00', 'TOUT_PRET']]);
    const k = m.courseDe('a')!;
    expect(m.courseDe('b')!.id).toBe(k.id);
    expect(hms(m.commandes.get('a')!.remise_at!)).toBe('15:40:00');
    expect(hms(m.commandes.get('b')!.remise_at!)).toBe('15:40:00');
    expect(hms(k.parti_at!)).toBe('15:40:30');
    // Arrivées (remise de 3 min comptée à part) dans la promesse + 5 min : A avant 16:00, B avant 16:05.
    expect(hms(m.commandes.get('a')!.livree_at!)).toBe('16:02:35');
    expect(hms(m.commandes.get('b')!.livree_at!)).toBe('16:07:29');
    expect(m.toutes('CONFIER_TURBO')).toEqual([]);
    expect(m.violations).toEqual([]);
  });

  it('A à 7 km : attendre réduit le délai total des clients (attente courte seule : B attend le retour de D1)', () => {
    const long = scene(5000, SANS_TURBO).jusqua(h('16:45'));
    const court = scene(5000, SANS_TURBO_COURT).jusqua(h('16:45'));

    // Attente courte seule : A part à 15:29, D1 revient vers 16:10, B (prête à 15:40) part à 16:11:20.
    expect(m2(court)).toEqual({ a: '15:51:05', b: '16:35:19' });
    expect(m2(long)).toEqual({ a: '16:02:35', b: '16:07:29' });
    const dL = delais(long);
    const dC = delais(court);
    // A : 11 min 30 s de plus (dans sa promesse) ; B : 28 min de moins ; au total, 16 min de moins.
    expect(dL.a - dC.a).toBeCloseTo(11.5, 1);
    expect(dC.b - dL.b).toBeCloseTo(27.8, 1);
    expect(dL.total).toBeLessThan(dC.total);
    expect(dC.total - dL.total).toBeCloseTo(16.3, 1);
    expect(long.violations).toEqual([]);
    expect(court.violations).toEqual([]);
  });

  it('A à 1,5 km (aller-retour de 11 min) : A part tout de suite, D1 revient à temps pour B', () => {
    const m = scene(1070).jusqua(h('16:15'));

    expect(m.toutes('RETENIR')).toEqual([]);
    expect(m.historique.some(({ plan }) => plan.refus.some((r) => r.order_id === 'b' && r.refus === 'HORIZON'))).toBe(true);
    expect(hms(m.commandes.get('a')!.remise_at!)).toBe('15:28:30');
    expect(hms(m.courseDe('a')!.parti_at!)).toBe('15:29:00');
    // D1 revient vers 15:40:12 : la course de B (créée à 15:40) lui est proposée au passage suivant.
    expect(m.toutes('CREER_COURSE').map((x) => [hms(x.t), x.action.order_ids])).toEqual([
      ['15:28:00', ['a']],
      ['15:40:00', ['b']],
    ]);
    expect(m.toutes('OFFRIR').map((x) => [hms(x.t), x.action.deliverer_id])).toEqual([
      ['15:28:00', 'd1'],
      ['15:40:20', 'd1'],
    ]);
    expect(m2(m)).toEqual({ a: '15:36:05', b: '16:05:19' });
    expect(m.toutes('CONFIER_TURBO')).toEqual([]);
    expect(m.violations).toEqual([]);

    // Exactement comme avec l'attente courte seule.
    const court = scene(1070, COURT).jusqua(h('16:15'));
    expect(court.historique.map(({ plan }) => plan.actions)).toEqual(m.historique.map(({ plan }) => plan.actions));
    // Le faire attendre ici (attente courte élargie à 15 min) coûterait aux deux clients.
    const force = scene(1070, { ...REGLAGES_PLANIFICATION_DEFAUT, horizonPreparationS: 900, attenteMaxCommandePreteS: 900 }).jusqua(h('16:15'));
    expect(m2(force)).toEqual({ a: '15:47:35', b: '16:07:29' });
    expect(delais(force).total - delais(m).total).toBeCloseTo(13.7, 1);
  });
});

/** Heures de remise chez le client de A et B. */
function m2(m: Monde): { a: string; b: string } {
  return { a: hms(m.commandes.get('a')!.livree_at!), b: hms(m.commandes.get('b')!.livree_at!) };
}

describe('zéro offre à un livreur en pause', () => {
  it('D1 en pause au comptoir : rien tant qu’il n’a pas repris, la course dès qu’il reprend', () => {
    const m = new Monde(h('12:29:50'))
      .livreur('d1', { libreDepuis: h('12:00'), pause_until: FIN_PAUSE_INDEFINIE })
      .livreur('d2', { libreDepuis: h('12:00'), pause_until: h('13:30') })
      .commande('a', { est: 2000, creee: h('12:20'), enPreparation: h('12:22'), prete: h('12:30') });
    m.prevoir(h('12:33'), () => m.reprendre('d1'));
    m.jusqua(h('12:50'));

    expect(m.toutes('CREER_COURSE').map((x) => hms(x.t))).toEqual(['12:30:00']);
    expect(m.toutes('OFFRIR').map((x) => [hms(x.t), x.action.deliverer_id])).toEqual([['12:33:00', 'd1']]);
    expect(m.toutes('OFFRIR').some((x) => x.action.deliverer_id === 'd2')).toBe(false);
    expect(m.toutes('CONFIER_TURBO')).toEqual([]);
    expect(m.commandes.get('a')!.statut).toBe(OrderStatus.COMPLETED);
    expect(m.violations).toEqual([]);
  });
});

describe('le livreur qui se libère reçoit aussitôt la course la plus urgente', () => {
  it('deux courses attendent ; D1 revient : la plus urgente ; D2 revient : l’autre', () => {
    const m = new Monde(h('12:29:50'), SANS_TURBO)
      .livreur('d1', { libreDepuis: null })
      .livreur('d2', { libreDepuis: null })
      .commande('a', { est: 2000, creee: h('12:00'), enPreparation: h('12:05'), prete: h('12:20') })
      .commande('b', { est: -2000, creee: h('12:15'), enPreparation: h('12:17'), prete: h('12:25') })
      .courseExistante('KB', ['b'], { creee: h('12:25') })
      .courseExistante('KA', ['a'], { creee: h('12:20') });
    m.prevoir(h('12:30'), () => m.reprendre('d1'));
    m.prevoir(h('12:31'), () => m.reprendre('d2'));
    m.jusqua(h('13:10'));

    expect(m.toutes('OFFRIR').map((x) => [hms(x.t), x.action.course_id, x.action.deliverer_id])).toEqual([
      ['12:30:00', 'KA', 'd1'],
      ['12:31:00', 'KB', 'd2'],
    ]);
    expect(m.toutes('OFFRIR')[0].action.marge_s).toBeLessThan(m.toutes('OFFRIR')[1].action.marge_s);
    expect(m.violations).toEqual([]);
  });
});

describe('rush : 2 livreurs pour 6 commandes', () => {
  it('regroupement par direction, ajout après retrait, aucune offre perdue, aucun temps mort, tout livré', () => {
    const m = new Monde(h('11:59:50'), SANS_TURBO)
      .livreur('d1', { libreDepuis: h('11:50'), delaiDepartS: 60 })
      .livreur('d2', { libreDepuis: h('11:55'), delaiDepartS: 60 })
      // Est
      .commande('o1', { est: 2000, creee: h('11:55'), enPreparation: h('11:58'), prete: h('12:08') })
      .commande('o2', { est: 2600, nord: 300, creee: h('11:57'), enPreparation: h('12:00'), prete: h('12:08:40') })
      .commande('o5', { est: 1500, creee: h('12:02'), enPreparation: h('12:05'), prete: h('12:14'), finCuisine: h('12:14') })
      // Nord
      .commande('o3', { nord: 2200, est: 0, creee: h('11:58'), enPreparation: h('12:01'), prete: h('12:09') })
      .commande('o4', { nord: 2600, est: 300, creee: h('12:00'), enPreparation: h('12:03'), prete: h('12:13') })
      .commande('o6', { nord: 1800, est: 0, creee: h('12:04'), enPreparation: h('12:07'), prete: h('12:20') });
    m.jusqua(h('13:30'));

    const ids = ['o1', 'o2', 'o3', 'o4', 'o5', 'o6'];
    for (const id of ids) expect(m.commandes.get(id)!.statut).toBe(OrderStatus.COMPLETED);
    expect(m.violations).toEqual([]);

    const courses = new Map<string, string[]>();
    for (const id of ids) {
      const k = m.courseDe(id)!.id;
      courses.set(k, [...(courses.get(k) ?? []), id]);
    }
    const groupes = [...courses.values()].map((g) => g.sort());
    // Jamais l'est avec le nord ; au moins deux tournées groupées ; moins de courses que de commandes.
    // Trajet long : o3 (nord, prête à 12:09) attend o4 (prête à 12:13) au comptoir,
    // au lieu de partir seule et de laisser o4 attendre le retour d'un livreur
    // (attente cumulée au comptoir : 47,7 min au lieu de 52, délais clients : 203 min au lieu de 207,5).
    expect(groupes).toEqual(expect.arrayContaining([['o1', 'o2'], ['o3', 'o4']]));
    expect(courses.size).toBeLessThan(ids.length);
    for (const g of groupes) {
      const est = g.some((id) => ['o1', 'o2', 'o5'].includes(id));
      const nord = g.some((id) => ['o3', 'o4', 'o6'].includes(id));
      expect(est && nord).toBe(false);
    }
    // o2 est arrivée pendant que D1, sa course récupérée, était encore au comptoir.
    expect(m.toutes('AJOUTER').find((x) => x.action.order_id === 'o2')!.action.apres_retrait).toBe(true);
    // Chaque livreur a fait au moins deux courses.
    expect(m.livreurs.get('d1')!.courses_du_jour).toBeGreaterThanOrEqual(2);
    expect(m.livreurs.get('d2')!.courses_du_jour).toBeGreaterThanOrEqual(2);
  });
});

describe('rush avec les positions telles que l’appli les envoie aujourd’hui (seconde relecture)', () => {
  it('rien hors course appli fermée : tout est livré, aucune violation, aucun temps mort plus fin', () => {
    const m = new Monde(h('11:59:50'), SANS_TURBO, { positionsCommeLAppli: true })
      .livreur('d1', { libreDepuis: h('11:50'), delaiDepartS: 60 })
      .livreur('d2', { libreDepuis: h('11:55'), delaiDepartS: 60 })
      .commande('o1', { est: 2000, creee: h('11:55'), enPreparation: h('11:58'), prete: h('12:08') })
      .commande('o2', { est: 2600, nord: 300, creee: h('11:57'), enPreparation: h('12:00'), prete: h('12:08:40') })
      .commande('o5', { est: 1500, creee: h('12:02'), enPreparation: h('12:05'), prete: h('12:14'), finCuisine: h('12:14') })
      .commande('o3', { nord: 2200, est: 0, creee: h('11:58'), enPreparation: h('12:01'), prete: h('12:09') })
      .commande('o4', { nord: 2600, est: 300, creee: h('12:00'), enPreparation: h('12:03'), prete: h('12:13') })
      .commande('o6', { nord: 1800, est: 0, creee: h('12:04'), enPreparation: h('12:07'), prete: h('12:20') });
    m.jusqua(h('13:30'));

    for (const id of ['o1', 'o2', 'o3', 'o4', 'o5', 'o6']) expect(m.commandes.get(id)!.statut).toBe(OrderStatus.COMPLETED);
    expect(m.violations).toEqual([]);
    expect(m.tempsMort).toEqual({ courseDUnAutreLivreur: 0, offreLointaine: 0, expireeSeulement: 0 });
  });
});

describe('offre laissée expirer, téléphone en poche, puis appli rouverte au comptoir (seconde relecture)', () => {
  it('la course lui revient dès qu’il rouvre l’appli, Turbo n’est pas appelé', () => {
    // D1 au comptoir ne voit pas l'offre (il accepterait au bout de 10 min) ; D2 loin en tournée.
    const m = new Monde(h('11:59:50'))
      .livreur('d1', { libreDepuis: h('11:30'), delaiAcceptationS: 600 })
      .livreur('d2', { libreDepuis: h('11:00') })
      .commande('z', { est: 6000, creee: h('11:30'), enPreparation: h('11:35'), prete: h('11:50') })
      .courseEnTournee('d2', ['z'], h('11:55'))
      .commande('a', { est: 2000, creee: h('11:45'), enPreparation: h('11:48'), prete: h('12:00') });
    // 12:03 : il rouvre l'appli (position envoyée), et répond vite cette fois.
    m.prevoir(h('12:03'), () => {
      m.livreurs.get('d1')!.delaiAcceptationS = 10;
      m.reprendre('d1');
    });
    m.jusqua(h('12:30'));

    expect(m.toutes('OFFRIR').map((x) => [hms(x.t), x.action.deliverer_id])).toEqual([
      ['12:00:00', 'd1'],
      ['12:03:00', 'd1'],
    ]);
    expect(m.toutes('CONFIER_TURBO')).toEqual([]);
    expect(m.courseDe('a')!.deliverer_id).toBe('d1');
    // Entre l'expiration (12:02) et la réouverture (12:03), la course n'a été « laissée expirer » que par lui : compté.
    expect(m.tempsMort.expireeSeulement).toBe(60);
    expect(m.violations).toEqual([]);
  });
});

describe('le banc lui-même : le monde détecte bien les fautes', () => {
  it('offre à un livreur en pause, temps mort, retenue repoussée', () => {
    const m = new Monde(h('12:29:50'))
      .livreur('d1', { libreDepuis: h('12:00'), pause_until: FIN_PAUSE_INDEFINIE })
      .livreur('d2', { libreDepuis: h('12:00') })
      .commande('a', { est: 2000, creee: h('12:20'), enPreparation: h('12:22'), prete: h('12:30') });
    const banc = m as unknown as {
      appliquer(plan: { actions: unknown[] }): void;
      controlerTempsMort(): void;
    };
    m.t = h('12:30');
    banc.appliquer({
      actions: [
        { type: 'CREER_COURSE', cle: 'n', order_ids: ['a'], sequence: ['a'], motif: null, libelle: '' },
        { type: 'OFFRIR', course_cle: 'n', course_id: null, deliverer_id: 'd1', marge_s: 0, cout: {}, libelle: '' },
      ],
    });
    expect(m.violations).toEqual([expect.stringContaining('offre à d1 qui ne peut pas la recevoir (EN_PAUSE)')]);

    const k = m.courseDe('a')!;
    k.offre = null;
    banc.controlerTempsMort();
    expect(m.violations[1]).toContain('temps mort : d2 libre');

    k.retenue_jusqua = h('12:33');
    banc.appliquer({ actions: [{ type: 'RETENIR', course_id: k.id, deliverer_id: null, jusqua: h('12:34'), attendues: [], libelle: '' }] });
    expect(m.violations[2]).toContain('repoussée');
  });

  it('temps morts plus fins, comptés en secondes : course d’un autre livreur en route, offre lointaine, offre seulement expirée', () => {
    const m = new Monde(h('12:29:50'))
      .livreur('d1', { libreDepuis: h('12:00') })
      .livreur('d2', { libreDepuis: h('12:00'), position: { lat: R.lat + 0.03, lng: R.lng } })
      .commande('a', { est: 2000, creee: h('12:20'), enPreparation: h('12:22'), prete: h('12:30') });
    const banc = m as unknown as { appliquer(plan: { actions: unknown[] }): void; controlerTempsMort(): void };
    m.t = h('12:30');
    m.commandes.get('a')!.statut = OrderStatus.READY;
    banc.appliquer({ actions: [{ type: 'CREER_COURSE', cle: 'n', order_ids: ['a'], sequence: ['a'], motif: null, libelle: '' }] });
    const k = m.courseDe('a')!;

    // (2) Offre à D2, à plus de 2 min, pendant que D1 attend au comptoir.
    k.offre = { id: 'o', deliverer_id: 'd2', offered_at: m.t, expires_at: h('12:32') };
    banc.controlerTempsMort();
    // (1) Course acceptée par D2, encore en route.
    k.offre = null;
    k.statut = CourseStatut.ACCEPTED;
    k.deliverer_id = 'd2';
    banc.controlerTempsMort();
    // (3) Course seulement laissée expirer par D1, sans signe de vie depuis.
    k.statut = CourseStatut.PENDING_ASSIGNMENT;
    k.deliverer_id = null;
    k.expirees.push({ deliverer_id: 'd1', a: h('12:31') });
    banc.controlerTempsMort();

    expect(m.tempsMort).toEqual({ courseDUnAutreLivreur: 10, offreLointaine: 10, expireeSeulement: 10 });
  });
});
