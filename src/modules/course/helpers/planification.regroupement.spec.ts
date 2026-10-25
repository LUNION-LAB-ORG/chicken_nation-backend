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
const libreAuComptoir = (id: string, t: Date) => livr(id, t, { auComptoir: true, protocole_appli: 4 });

/** Monde du terrain : la caisse remet dès le code. */
const mondeDuTerrain = (debut: Date) => new Monde(debut, r, { caisseRemetAuCode: true });

/** [heure, motif ou commande, échéance] de chaque action d'un type. */
const lignes = (m: Monde, type: ActionPlanification['type']) =>
  m.toutes(type).map(({ t, action }) => {
    const a = action as { motif?: string | null; order_id?: string; jusqua?: Date };
    return [hms(t), a.motif ?? a.order_id ?? null, a.jusqua ? hms(a.jusqua) : null];
  });
const refusRetenue = (plan: ReturnType<typeof planifier>) =>
  plan.refus.filter((x) => x.essai === 'RETENUE').map((x) => x.refus);

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

describe('S3. deux livreurs : la même direction part ensemble, le second reste libre', () => {
  it('L1 et L2 libres au comptoir ; A 12:30, B annoncée 12:33, C (autre direction) 12:35 : A+B avec L1, C avec L2', () => {
    const m = mondeDuTerrain(h('12:29:50'))
      .livreur('l1', { libreDepuis: h('12:00'), protocole_appli: 4 })
      .livreur('l2', { libreDepuis: h('12:05'), protocole_appli: 4 })
      .commande('a', { est: 2000, creee: h('12:15'), enPreparation: h('12:18'), prete: h('12:30') })
      .commande('b', { est: 2200, creee: h('12:18'), enPreparation: h('12:22'), prete: h('12:33'), finCuisine: h('12:33') })
      .commande('c', { est: -2000, creee: h('12:20'), enPreparation: h('12:24'), prete: h('12:35') })
      .jusqua(h('13:10'));
    expect(lignes(m, 'RETENIR')).toEqual([['12:30:10', 'ATTENTE_COURTE', '12:33:00']]);
    expect(m.courseDe('b')!.id).toBe(m.courseDe('a')!.id);
    expect(m.courseDe('a')!.deliverer_id).toBe('l1');
    expect(m.courseDe('c')!.deliverer_id).toBe('l2');
    expect(m.toutes('OFFRIR').map(({ t, action }) => [hms(t), action.deliverer_id])).toEqual([
      ['12:30:00', 'l1'],
      ['12:35:00', 'l2'],
    ]);
    expect(m.violations).toEqual([]);
  });

  it('S3b. trajet long avec un autre livreur libre au comptoir : pas d’attente de 12 min (inchangé), B ira à L2', () => {
    const t = h('15:28:20');
    const a = cmd('a', { est: 5000, created_at: h('15:20'), ready_at: h('15:28') });
    const b = enPrep('b', h('15:40'), { est: 5500, created_at: h('15:25') });
    const plan = planifier(
      instant(t, {
        commandes: [b],
        courses: [crs('k', { statut: CourseStatut.AT_RESTAURANT, deliverer_id: 'd1', commandes: [a] })],
        livreurs: [enCourseAuComptoir('d1', t), libreAuComptoir('d2', t)],
      }),
    );
    expect(actionsDe(plan, 'RETENIR')).toEqual([]);
    expect(refusRetenue(plan)).toEqual(['AUTRE_LIVREUR_LIBRE']);
  });

  it('S3c. attente courte avec un livreur EN COURSE qui revient dans les 3 min : la retenue est posée', () => {
    const t = h('12:30:15');
    const a = cmd('a', { est: 2000, created_at: h('12:15'), ready_at: h('12:30') });
    const b = enPrep('b', h('12:33'), { est: 2200, created_at: h('12:18') });
    const z = cmd('z', { est: 300, created_at: h('11:50'), ready_at: h('12:10'), statut: OrderStatus.PICKED_UP });
    const plan = planifier(
      instant(t, {
        commandes: [b],
        courses: [
          crs('ka', { commandes: [a], statut: CourseStatut.AT_RESTAURANT, deliverer_id: 'l1', assigned_at: h('12:30:10') }),
          crs('kz', {
            statut: CourseStatut.IN_DELIVERY,
            deliverer_id: 'l2',
            picked_up_at: h('12:25'),
            parti_at: h('12:26'),
            livraisons: [{ id: 'liv-z', statut: DeliveryStatut.IN_ROUTE, sequence_order: 1, commande: z }],
          }),
        ],
        livreurs: [enCourseAuComptoir('l1', t), livr('l2', t, { aEst: 300, protocole_appli: 4, etat: { en_course: true, last_available_at: null } })],
      }),
    );
    expect(actionsDe(plan, 'RETENIR').map((x) => [hms(x.jusqua), x.motif])).toEqual([['12:33:00', 'ATTENTE_COURTE']]);
  });

  it('S3d. livreur de retour avant la fin de B + 3 min, trajet long : pas d’attente (inchangé)', () => {
    const t = h('16:00:10');
    const a = cmd('a', { est: 2500, created_at: h('15:50'), ready_at: h('16:00') });
    const b = enPrep('b', h('16:08'), { est: 2000, created_at: h('15:52') });
    const z = cmd('z', { est: 700, created_at: h('15:30'), ready_at: h('15:50'), statut: OrderStatus.PICKED_UP });
    const plan = planifier(
      instant(t, {
        commandes: [b],
        courses: [
          crs('ka', { commandes: [a], statut: CourseStatut.AT_RESTAURANT, deliverer_id: 'l1', assigned_at: h('16:00:05') }),
          crs('kz', {
            statut: CourseStatut.IN_DELIVERY,
            deliverer_id: 'l2',
            picked_up_at: h('15:55'),
            parti_at: h('15:56'),
            livraisons: [{ id: 'liv-z', statut: DeliveryStatut.IN_ROUTE, sequence_order: 1, commande: z }],
          }),
        ],
        livreurs: [enCourseAuComptoir('l1', t), livr('l2', t, { aEst: 700, protocole_appli: 4, etat: { en_course: true, last_available_at: null } })],
      }),
    );
    expect(actionsDe(plan, 'RETENIR')).toEqual([]);
    expect(refusRetenue(plan)).toEqual(['AUTRE_LIVREUR_LIBRE']);
  });
});

describe('S4. commandes déjà en retard seules : elles ne bloquent plus la course du livreur', () => {
  it('S4a. B prête rejoint la course au comptoir pas encore récupérée (A et B passées à 11:55 et 11:56)', () => {
    const a = cmd('a', { est: 3000, created_at: h('11:55'), ready_at: h('12:30') });
    const b = cmd('b', { est: 1500, created_at: h('11:56'), ready_at: h('12:31') });
    const t = h('12:31:05');
    const plan = planifier(
      instant(t, {
        commandes: [b],
        courses: [crs('ka', { commandes: [a], statut: CourseStatut.AT_RESTAURANT, deliverer_id: 'l1', assigned_at: h('12:30:10') })],
        livreurs: [enCourseAuComptoir('l1', t)],
      }),
    );
    expect(actionsDe(plan, 'AJOUTER').map((x) => [x.order_id, x.course_id])).toEqual([['b', 'ka']]);
    expect(actionsDe(plan, 'CREER_COURSE')).toEqual([]);
  });

  it('S4a. même chose pour une course déjà récupérée, livreur encore au comptoir', () => {
    const a = cmd('a', { est: 3000, created_at: h('11:55'), ready_at: h('12:30'), statut: OrderStatus.PICKED_UP });
    const b = cmd('b', { est: 1500, created_at: h('11:56'), ready_at: h('12:31') });
    const t = h('12:31:05');
    const plan = planifier(
      instant(t, {
        commandes: [b],
        courses: [
          crs('ka', {
            commandes: [a],
            statut: CourseStatut.IN_DELIVERY,
            deliverer_id: 'l1',
            assigned_at: h('12:30:10'),
            picked_up_at: h('12:30:30'),
          }),
        ],
        livreurs: [enCourseAuComptoir('l1', t, h('12:30:20'))],
      }),
    );
    expect(actionsDe(plan, 'AJOUTER').map((x) => [x.order_id, x.course_id, x.apres_retrait])).toEqual([['b', 'ka', true]]);
  });

  describe('S4b. retenue et retard de A', () => {
    const t = h('12:30:15');
    const b = enPrep('b', h('12:33'), { est: 2200, created_at: h('12:02') });
    const plan = (creeeA: string) =>
      planifier(
        instant(t, {
          commandes: [b],
          courses: [
            crs('ka', {
              commandes: [cmd('a', { est: 2000, created_at: h(creeeA), ready_at: h('12:30') })],
              statut: CourseStatut.AT_RESTAURANT,
              deliverer_id: 'l1',
              assigned_at: h('12:30:10'),
            }),
          ],
          livreurs: [enCourseAuComptoir('l1', t)],
        }),
      );
    it('A passée à 12:00, déjà en retard seule : retenue posée', () => {
      expect(actionsDe(plan('12:00'), 'RETENIR').map((x) => hms(x.jusqua))).toEqual(['12:33:00']);
    });
    it('A passée à 12:02, à l’heure seule et en retard après l’attente : refusée (inchangé)', () => {
      const p = plan('12:02');
      expect(actionsDe(p, 'RETENIR')).toEqual([]);
      expect(p.refus.filter((x) => x.essai === 'RETENUE').map((x) => [x.refus, x.libelle])).toEqual([
        ['RETARD_CLIENT', 'CMD-A arriverait en retard'],
      ]);
    });
    it('A passée à 12:05 : retenue posée (inchangé)', () => {
      expect(actionsDe(plan('12:05'), 'RETENIR').map((x) => hms(x.jusqua))).toEqual(['12:33:00']);
    });
  });

  describe('S4c. deux courses sans livreur (fusion), deux livreurs sur le retour', () => {
    const t = h('12:31');
    const plan = (creeeB: string) => {
      const u = crs('u', { commandes: [cmd('a', { ready_at: h('12:30'), created_at: h('12:20'), est: 3000 })], created_at: h('12:30') });
      const v = crs('v', { commandes: [cmd('b', { ready_at: h('12:31'), created_at: h(creeeB), est: 3800 })], created_at: h('12:31') });
      const enRetour = (id: string, est: number) => livr(id, t, { aEst: est, etat: { en_course: true, last_available_at: null } });
      const k1 = crs('k1', {
        statut: CourseStatut.IN_DELIVERY,
        deliverer_id: 'd1',
        picked_up_at: h('12:10'),
        parti_at: h('12:11'),
        livraisons: [{ id: 'l1', statut: DeliveryStatut.DELIVERED, sequence_order: 1, commande: cmd('x', { statut: OrderStatus.PICKED_UP, est: -1500 }) }],
      });
      return planifier(instant(t, { courses: [u, v, k1], livreurs: [enRetour('d1', -700), enRetour('d2', -900)] }));
    };
    it('B passée à 12:12, déjà en retard seule : fusionnée avec A (relecture du 25/10, la même direction part ensemble)', () => {
      expect(actionsDe(plan('12:12'), 'FUSIONNER').map((x) => [x.cible_id, x.absorbee_id])).toEqual([['u', 'v']]);
    });
    it('B passée à 12:16, à l’heure seule et en retard avec la fusion : refusée (inchangé)', () => {
      const p = plan('12:16');
      expect(actionsDe(p, 'FUSIONNER')).toEqual([]);
      expect(p.refus.some((x) => x.essai === 'FUSION' && x.refus === 'RETARD_CLIENT')).toBe(true);
    });
  });
});

describe('S5. une commande entrée en préparation APRÈS la fin d’une retenue peut être attendue', () => {
  const a = cmd('a', { est: 2000, created_at: h('12:15'), ready_at: h('12:30') });
  const bPrete = cmd('b', { est: 2200, created_at: h('12:18'), ready_at: h('12:32') });
  const t = h('12:32:40');
  const plan = (debutC: string | null) =>
    planifier(
      instant(t, {
        commandes: [enPrep('c', h('12:34'), { est: 2400, created_at: h('12:20'), prepared_at: debutC ? h(debutC) : null })],
        courses: [
          crs('ka', {
            commandes: [a, bPrete],
            statut: CourseStatut.AT_RESTAURANT,
            deliverer_id: 'l1',
            retenue_jusqua: h('12:32'),
            commandes_attendues: [],
          }),
        ],
        livreurs: [enCourseAuComptoir('l1', t)],
      }),
    );
  it('C en préparation depuis 12:32:30 (après la levée de 12:32) : retenue jusqu’à 12:34', () => {
    expect(actionsDe(plan('12:32:30'), 'RETENIR').map((x) => [hms(x.jusqua), x.attendues.map((y) => y.order_id)])).toEqual([
      ['12:34:00', ['c']],
    ]);
  });
  it('C en préparation depuis 12:25 (déjà jugée pendant la retenue) : jamais reposée, comme avant', () => {
    expect(plan('12:25').actions).toEqual([]);
  });
  it('début de préparation inconnu : jamais reposée', () => {
    expect(plan(null).actions).toEqual([]);
  });
  it('retenue encore en cours : la commande nouvelle ne la repousse pas (inchangé)', () => {
    const t2 = h('12:31:40');
    const p = planifier(
      instant(t2, {
        commandes: [enPrep('c', h('12:34'), { est: 2400, created_at: h('12:20'), prepared_at: h('12:31:30') })],
        courses: [
          crs('ka', {
            commandes: [a],
            statut: CourseStatut.AT_RESTAURANT,
            deliverer_id: 'l1',
            retenue_jusqua: h('12:33'),
            commandes_attendues: ['b'],
          }),
        ],
        livreurs: [enCourseAuComptoir('l1', t2)],
      }),
    );
    expect(actionsDe(p, 'RETENIR')).toEqual([]);
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

describe('S15. commandes de test passées tôt, deux livreurs : le retard ne sépare plus la même direction (relecture du 25/10)', () => {
  it('S3 mot pour mot, commandes passées à 11:50, 11:52 et 11:54 : A+B avec L1 après l’attente, C avec L2, pas de Turbo', () => {
    const m = mondeDuTerrain(h('12:29:50'))
      .livreur('l1', { libreDepuis: h('12:00'), protocole_appli: 4 })
      .livreur('l2', { libreDepuis: h('12:05'), protocole_appli: 4 })
      .commande('a', { est: 2000, creee: h('11:50'), enPreparation: h('12:18'), prete: h('12:30') })
      .commande('b', { est: 2200, creee: h('11:52'), enPreparation: h('12:22'), prete: h('12:33'), finCuisine: h('12:33') })
      .commande('c', { est: -2000, creee: h('11:54'), enPreparation: h('12:24'), prete: h('12:35') })
      .jusqua(h('13:10'));
    expect(lignes(m, 'RETENIR')).toEqual([['12:30:10', 'ATTENTE_COURTE', '12:33:00']]);
    expect(m.courseDe('b')!.id).toBe(m.courseDe('a')!.id);
    expect(m.courseDe('a')!.deliverer_id).toBe('l1');
    expect(m.courseDe('c')!.deliverer_id).toBe('l2');
    expect(m.toutes('OFFRIR').map(({ t, action }) => [hms(t), action.deliverer_id])).toEqual([
      ['12:30:00', 'l1'],
      ['12:35:00', 'l2'],
    ]);
    expect(m.toutes('CONFIER_TURBO')).toEqual([]);
    expect(m.violations).toEqual([]);
  });

  it('A et B prêtes ensemble, déjà en retard seules, deux livreurs libres : une seule course, L2 reste libre', () => {
    const m = mondeDuTerrain(h('12:29:50'))
      .livreur('l1', { libreDepuis: h('12:00'), protocole_appli: 4 })
      .livreur('l2', { libreDepuis: h('12:05'), protocole_appli: 4 })
      .commande('a', { est: 2000, creee: h('11:50'), enPreparation: h('12:18'), prete: h('12:30') })
      .commande('b', { est: 2200, creee: h('11:52'), enPreparation: h('12:22'), prete: h('12:30') })
      .jusqua(h('13:00'));
    expect(m.courseDe('b')!.id).toBe(m.courseDe('a')!.id);
    expect(m.toutes('OFFRIR').map(({ t, action }) => [hms(t), action.deliverer_id])).toEqual([['12:30:00', 'l1']]);
    expect(m.violations).toEqual([]);
  });

  describe('S4a avec un second livreur libre au comptoir : B prête, plus loin que A, rejoint la course de L1', () => {
    const t = h('12:31:05');
    const plan = (creeeA: string, creeeB: string) =>
      planifier(
        instant(t, {
          commandes: [cmd('b', { est: 3000, created_at: h(creeeB), ready_at: h('12:31') })],
          courses: [
            crs('ka', {
              commandes: [cmd('a', { est: 1500, created_at: h(creeeA), ready_at: h('12:30') })],
              statut: CourseStatut.AT_RESTAURANT,
              deliverer_id: 'l1',
              assigned_at: h('12:30:10'),
            }),
          ],
          livreurs: [enCourseAuComptoir('l1', t), libreAuComptoir('l2', t)],
        }),
      );
    it('commandes passées à 11:55 et 11:56 (déjà en retard seules) : AJOUTER b, aucune course pour L2', () => {
      const p = plan('11:55', '11:56');
      expect(actionsDe(p, 'AJOUTER').map((x) => [x.order_id, x.course_id])).toEqual([['b', 'ka']]);
      expect(actionsDe(p, 'CREER_COURSE')).toEqual([]);
      expect(actionsDe(p, 'OFFRIR')).toEqual([]);
    });
    it('commandes à l’heure (12:15 et 12:16) : AJOUTER b, comme avant', () => {
      expect(actionsDe(plan('12:15', '12:16'), 'AJOUTER').map((x) => [x.order_id, x.course_id])).toEqual([['b', 'ka']]);
    });
  });

  it('retenue courte avec un second livreur libre : B (plus loin, déjà en retard seule) est attendue', () => {
    const t = h('12:30:15');
    const p = planifier(
      instant(t, {
        commandes: [enPrep('b', h('12:33'), { est: 3000, created_at: h('11:56') })],
        courses: [
          crs('ka', {
            commandes: [cmd('a', { est: 1500, created_at: h('11:55'), ready_at: h('12:30') })],
            statut: CourseStatut.AT_RESTAURANT,
            deliverer_id: 'l1',
            assigned_at: h('12:30:10'),
          }),
        ],
        livreurs: [enCourseAuComptoir('l1', t), libreAuComptoir('l2', t)],
      }),
    );
    expect(actionsDe(p, 'RETENIR').map((x) => [hms(x.jusqua), x.motif])).toEqual([['12:33:00', 'ATTENTE_COURTE']]);
    expect(refusRetenue(p)).toEqual([]);
  });
});

describe('S16. retenue NOUVELLE après la remise : décidée comme un ajout, jamais en fin de fenêtre (relecture du 25/10)', () => {
  /**
   * 15 h 28, hors pointe, D1 seul. A (5 km à l'est, créée 15:20, prête 15:28)
   * remise au code à 15:28:30 SANS retenue : « Sacs remis / Tu peux partir ».
   * Dernière position précise de D1 au comptoir, avant la remise (téléphone
   * qui n'envoie plus rien). B (5,5 km), annoncée pour 15:40.
   */
  const aRemise = cmd('a', { est: 5000, created_at: h('15:20'), ready_at: h('15:28'), statut: OrderStatus.PICKED_UP });
  const livA = { id: 'liv-a', statut: DeliveryStatut.PENDING, sequence_order: 1, commande: aRemise };
  const k = (o: Parameters<typeof crs>[1] = {}) =>
    crs('ka', { statut: CourseStatut.IN_DELIVERY, deliverer_id: 'd1', assigned_at: h('15:28:10'), picked_up_at: h('15:28:30'), livraisons: [livA], ...o });
  const plan = (t: string, debutB: string, o: Parameters<typeof crs>[1] = {}, finB = '15:40') => {
    const tt = h(t);
    return planifier(
      instant(tt, {
        commandes: [enPrep('b', h(finB), { est: 5500, created_at: h('15:25'), prepared_at: h(debutB) })],
        courses: [k(o)],
        livreurs: [enCourseAuComptoir('d1', tt, h('15:28:20'))],
      }),
    );
  };

  it('B en préparation 5 s après la remise : retenue jusqu’à 15:40, la règle du client (trajet long)', () => {
    expect(actionsDe(plan('15:28:40', '15:28:35'), 'RETENIR').map((x) => [hms(x.jusqua), x.motif])).toEqual([['15:40:00', 'TRAJET_LONG']]);
  });

  it('B en préparation 3 min 45 s après la remise : plus aucune retenue, la course part à remise + 240 s', () => {
    const p = plan('15:32:20', '15:32:15');
    expect(actionsDe(p, 'RETENIR')).toEqual([]);
    expect(p.actions).toEqual([]);
    expect(actionsDe(plan('15:32:30', '15:32:15'), 'MARQUER_PARTI').map((x) => x.motif)).toEqual(['FENETRE_ECHUE']);
  });

  it('fenêtre prolongée pour un sac au comptoir : aucune retenue (la course attend seulement son sac)', () => {
    // Trajet court : A (2 km, prête 15:28:20) remise à 15:28:30 ; C (2,1 km)
    // ajoutée après la remise, pas encore remise ; B (2,2 km) en préparation
    // à 15:32:35, finie 15:33:10, dans l'attente courte de A.
    const a = cmd('a', { est: 2000, created_at: h('15:20'), ready_at: h('15:28:20'), statut: OrderStatus.PICKED_UP });
    const c = cmd('c', { est: 2100, created_at: h('15:22'), ready_at: h('15:31') });
    const tt = h('15:32:40');
    const p = planifier(
      instant(tt, {
        commandes: [enPrep('b', h('15:33:10'), { est: 2200, created_at: h('15:25'), prepared_at: h('15:32:35') })],
        courses: [
          k({
            livraisons: [
              { ...livA, commande: a },
              { id: 'liv-c', statut: DeliveryStatut.PENDING, sequence_order: 2, ajoutee_apres_retrait: true, commande: c },
            ],
          }),
        ],
        livreurs: [enCourseAuComptoir('d1', tt, h('15:28:20'))],
      }),
    );
    expect(actionsDe(p, 'MARQUER_PARTI')).toEqual([]);
    expect(actionsDe(p, 'RETENIR')).toEqual([]);
  });

  it('reprise après une retenue levée après la remise : seulement avant la fin de la fenêtre comptée depuis la levée', () => {
    // Retenue levée à 15:30 (fenêtre jusqu'à 15:34, marge de remise 90 s : 15:32:30).
    const levee = { retenue_jusqua: h('15:30'), commandes_attendues: [] };
    expect(actionsDe(plan('15:30:20', '15:30:10', levee), 'RETENIR').map((x) => [hms(x.jusqua), x.reprise_de && hms(x.reprise_de)])).toEqual([
      ['15:40:00', '15:30:00'],
    ]);
    expect(actionsDe(plan('15:33:00', '15:32:50', levee), 'RETENIR')).toEqual([]);
  });
});
