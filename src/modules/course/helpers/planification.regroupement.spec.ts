/**
 * REGROUPEMENT APRÈS L'ESSAI DU 25/10 (conception
 * `.banc-test-crm/regroupement-correction.md`, scénarios S1 à S9).
 *
 * Retour du client : « des commandes vont dans la même direction, une est
 * prête, le livreur est notifié d'une course et n'a plus droit aux autres
 * commandes en préparation car son statut est en cours, même s'il n'a pas
 * récupéré ». Ce qui est voulu : un livreur dont la course est acceptée mais
 * pas partie (au comptoir, ou A remise mais encore au restaurant) reste le
 * livreur naturel des commandes de sa direction ; elles rejoignent SA course,
 * prêtes, ou en préparation dans la règle d'attente du client. Il ne reçoit
 * jamais une deuxième course séparée.
 *
 * Restaurant Zone 4, clients à l'est (ou à l'ouest) en mètres, appli du
 * livreur au protocole 4 (celle de l'essai), réglages par défaut. Heure de
 * pointe (16 km/h) de 11 h 30 à 14 h 30. La caisse du terrain remet dès le
 * code, retenue ou non (`caisseRemetAuCode`).
 */
import { CourseStatut, DeliveryStatut, OrderStatus } from '@prisma/client';

import { peutRecevoirOffre } from 'src/modules/deliverers/helpers/disponibilite.rules';

import { actionsDe, cmd, crs, enPrep, h, hms, instant, livr, Monde, plus, R, types } from './monde-planification.simulee-spec';
import { ActionPlanification, fenetreApresRetrait, planifier, REGLAGES_PLANIFICATION_DEFAUT } from './planification.rules';

const r = REGLAGES_PLANIFICATION_DEFAUT;

/** Livreur en course, au comptoir (position précise au restaurant), appli de l'essai. */
const enCourseAuComptoir = (id: string, t: Date, vuA: Date = plus(t, -10)) =>
  livr(id, t, {
    auComptoir: true,
    position_at: vuA,
    position_sure: { position: R, position_at: vuA },
    protocole_appli: 4,
    etat: { en_course: true, last_available_at: null },
  });

/** Monde du terrain : la caisse remet dès le code. */
const mondeDuTerrain = (debut: Date) => new Monde(debut, r, { caisseRemetAuCode: true });

/** [heure, motif ou commande, échéance] de chaque action d'un type. */
const lignes = (m: Monde, type: ActionPlanification['type']) =>
  m.toutes(type).map(({ t, action }) => {
    const a = action as { motif?: string | null; order_id?: string; jusqua?: Date };
    return [hms(t), a.motif ?? a.order_id ?? null, a.jusqua ? hms(a.jusqua) : null];
  });

describe('S1. le scénario du client : un livreur au comptoir, la caisse remet A dès le code', () => {
  const monde = () =>
    mondeDuTerrain(h('12:29:50'))
      .livreur('d1', { libreDepuis: h('12:00'), protocole_appli: 4 })
      .livreur('d2', { libreDepuis: h('11:00'), protocole_appli: 4 })
      .commande('z', { nord: 5000, est: 0, creee: h('12:00'), enPreparation: h('12:05'), prete: h('12:20') })
      .courseEnTournee('d2', ['z'], h('12:25'))
      .commande('a', { est: 2500, creee: h('12:18'), enPreparation: h('12:19'), prete: h('12:30') })
      .commande('b', { est: 1500, creee: h('12:20'), enPreparation: h('12:24'), prete: h('12:34'), finCuisine: h('12:34') });

  it('A remise à 12:30:30 : la retenue garde 12:34, B rejoint la course à 12:34, un seul livreur, pas de Turbo', () => {
    const m = monde().jusqua(h('12:50'));
    const k = m.courseDe('a')!;
    expect(hms(k.picked_up_at!)).toBe('12:30:30');
    expect(lignes(m, 'RETENIR')).toEqual([['12:30:10', 'ATTENTE_COURTE', '12:34:00']]);
    expect(lignes(m, 'LIBERER')).toEqual([['12:34:00', 'TOUT_PRET', '12:34:00']]);
    expect(m.toutes('AJOUTER').map(({ t, action }) => [hms(t), action.order_id, action.apres_retrait, action.attendue])).toEqual([
      ['12:34:00', 'b', true, true],
    ]);
    expect(m.courseDe('b')!.id).toBe(k.id);
    expect(m.toutes('MARQUER_PARTI').filter(({ t, action }) => action.motif === 'FENETRE_ECHUE' && hms(t) < '12:34:10')).toEqual([]);
    expect(m.toutes('OFFRIR').map(({ t, action }) => [hms(t), action.deliverer_id])).toEqual([['12:30:00', 'd1']]);
    expect(m.toutes('CONFIER_TURBO')).toEqual([]);
    expect(m.violations).toEqual([]);
  });
});

describe('S2. trajet long : la remise ne rabote plus la retenue', () => {
  it('A (5 km) remise 15:28:30 ; B (5,5 km) prête 15:40 : retenue 15:40 gardée, B ajoutée, une course', () => {
    const m = mondeDuTerrain(h('15:27:50'))
      .livreur('d1', { libreDepuis: h('15:00'), protocole_appli: 4 })
      .commande('a', { est: 5000, creee: h('15:20'), enPreparation: h('15:21'), prete: h('15:28') })
      .commande('b', { est: 5500, creee: h('15:25'), enPreparation: h('15:28'), prete: h('15:40'), finCuisine: h('15:40') })
      .jusqua(h('15:50'));
    expect(hms(m.courseDe('a')!.picked_up_at!)).toBe('15:28:30');
    expect(lignes(m, 'RETENIR')).toEqual([['15:28:10', 'TRAJET_LONG', '15:40:00']]);
    expect(m.toutes('AJOUTER').map(({ t, action }) => [hms(t), action.order_id, action.apres_retrait])).toEqual([['15:40:00', 'b', true]]);
    expect(m.courseDe('b')!.id).toBe(m.courseDe('a')!.id);
    expect(m.toutes('CONFIER_TURBO')).toEqual([]);
    expect(m.violations).toEqual([]);
  });
});

describe('S6. ce qui ne change pas', () => {
  it('C prête dans une AUTRE direction : course à part, aucune offre au livreur en course', () => {
    const t = h('12:32');
    const d1 = enCourseAuComptoir('d1', t);
    const k = crs('k', {
      statut: CourseStatut.AT_RESTAURANT,
      deliverer_id: 'd1',
      commandes: [cmd('a', { est: 2500, created_at: h('12:18'), ready_at: h('12:30') })],
    });
    const c = cmd('c', { est: -2500, created_at: h('12:20'), ready_at: h('12:32') });
    const plan = planifier(instant(t, { commandes: [c], courses: [k], livreurs: [d1] }));
    expect(actionsDe(plan, 'CREER_COURSE').map((x) => x.order_ids)).toEqual([['c']]);
    expect(actionsDe(plan, 'OFFRIR')).toEqual([]);
    expect(peutRecevoirOffre(d1.etat, t)).toEqual({ ok: false, motif: 'EN_COURSE' });
  });

  it('sans retenue, la fenêtre après la remise reste 240 s (FIN_DE_FENETRE à 160 s)', () => {
    const t = h('16:03:10');
    const a = cmd('a', { est: 2500, created_at: h('15:45'), ready_at: h('16:00'), statut: OrderStatus.PICKED_UP });
    const b = cmd('b', { est: 2000, created_at: h('15:50'), ready_at: t });
    const k = crs('k', {
      statut: CourseStatut.IN_DELIVERY,
      deliverer_id: 'l',
      assigned_at: h('16:00'),
      picked_up_at: h('16:00:30'),
      commandes: [a],
    });
    const p = planifier(instant(t, { commandes: [b], courses: [k], livreurs: [enCourseAuComptoir('l', t, h('16:00:20'))] }));
    expect(p.refus.map((x) => `${x.essai}:${x.refus}`)).toEqual(['AJOUT:FIN_DE_FENETRE']);
  });

  it('retenue levée avant la remise : la fenêtre court depuis la remise', () => {
    const k = crs('k', {
      statut: CourseStatut.IN_DELIVERY,
      deliverer_id: 'l',
      picked_up_at: h('16:00:30'),
      retenue_jusqua: h('16:00:10'),
      commandes: [cmd('a', { statut: OrderStatus.PICKED_UP })],
    });
    const t = h('16:01');
    expect(fenetreApresRetrait(k, enCourseAuComptoir('l', t, h('16:00:20')), R, r, t)).toEqual({ ouverte: true, ferme_a: h('16:04:30') });
  });
});

describe('S7 à S9. la fenêtre au comptoir suit la retenue', () => {
  const aRemise = cmd('a', { est: 2000, created_at: h('12:15'), ready_at: h('12:30'), statut: OrderStatus.PICKED_UP });
  const k = (o: Parameters<typeof crs>[1] = {}) =>
    crs('ka', {
      statut: CourseStatut.IN_DELIVERY,
      deliverer_id: 'l1',
      assigned_at: h('12:30:10'),
      picked_up_at: h('12:30:30'),
      retenue_jusqua: h('12:34'),
      commandes_attendues: ['b'],
      livraisons: [{ id: 'liv-a', statut: DeliveryStatut.PENDING, sequence_order: 1, commande: aRemise }],
      ...o,
    });

  it('A remise pendant la retenue : la retenue garde son échéance, la course reste au comptoir', () => {
    const t = h('12:33:10');
    const plan = planifier(
      instant(t, { commandes: [enPrep('b', h('12:34'), { est: 2200, created_at: h('12:18') })], courses: [k()], livreurs: [enCourseAuComptoir('l1', t, h('12:30:20'))] }),
    );
    expect(plan.actions).toEqual([]);
  });

  it('S7. le livreur part quand même (position à 400 m après la remise) : course partie, retenue levée', () => {
    const t = h('12:31:10');
    const loin = { lat: R.lat, lng: R.lng + 0.0036 };
    const l1 = livr('l1', t, {
      position: loin,
      position_at: h('12:31'),
      position_sure: { position: loin, position_at: h('12:31') },
      protocole_appli: 4,
      etat: { en_course: true, last_available_at: null },
    });
    const plan = planifier(instant(t, { commandes: [enPrep('b', h('12:34'), { est: 2200, created_at: h('12:18') })], courses: [k()], livreurs: [l1] }));
    expect(types(plan)).toEqual(['MARQUER_PARTI', 'LIBERER']);
    expect(actionsDe(plan, 'MARQUER_PARTI')[0].motif).toBe('POSITION');
    expect(actionsDe(plan, 'LIBERER')[0].motif).toBe('PARTI');
  });

  it('S8. bornes de la fenêtre : ouverte jusqu’à la fin de la retenue + 240 s, échue ensuite', () => {
    const l1 = (t: Date) => enCourseAuComptoir('l1', t, h('12:30:20'));
    expect(fenetreApresRetrait(k(), l1(h('12:37:59')), R, r, h('12:37:59'))).toEqual({ ouverte: true, ferme_a: h('12:38') });
    expect(fenetreApresRetrait(k(), l1(h('12:38')), R, r, h('12:38'))).toEqual({ ouverte: false, motif: 'FENETRE_ECHUE' });
  });

  it('S9. B en retard sur son heure : levée à 12:34 (échéance), B prête 12:36 encore ajoutée, 12:36:40 trop tard', () => {
    const levee = () => k({ retenue_jusqua: h('12:34'), commandes_attendues: [] });
    const t1 = h('12:36');
    const p1 = planifier(
      instant(t1, {
        commandes: [cmd('b', { est: 2200, created_at: h('12:18'), ready_at: t1 })],
        courses: [levee()],
        livreurs: [enCourseAuComptoir('l1', t1, h('12:30:20'))],
      }),
    );
    expect(actionsDe(p1, 'AJOUTER').map((x) => [x.order_id, x.apres_retrait])).toEqual([['b', true]]);
    const t2 = h('12:36:40');
    const p2 = planifier(
      instant(t2, {
        commandes: [cmd('b', { est: 2200, created_at: h('12:18'), ready_at: t2 })],
        courses: [levee()],
        livreurs: [enCourseAuComptoir('l1', t2, h('12:30:20'))],
      }),
    );
    expect(p2.refus.map((x) => `${x.essai}:${x.refus}`)).toEqual(['AJOUT:FIN_DE_FENETRE']);
  });
});
