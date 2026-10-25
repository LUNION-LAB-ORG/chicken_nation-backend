/**
 * Planificateur v2, règles pures, une à la fois (conception 7.1) : réglages,
 * promesse, livreur au comptoir et choix en minutes (4.2), fenêtre après
 * retrait (3.8), Turbo v2 (3.11), puis `planifier` : création immédiate,
 * ajout à la bonne course ouverte, chaque limite de 3.6, retenue (posée,
 * jamais repoussée, réduite, levée), « autre livreur libre », ajout après
 * retrait et départ, détachement, ordre des arrêts, urgence des offres,
 * fusions des courses sans livreur (demande 4), jamais d'ajout ni de fusion
 * vers Turbo ou un livreur en pause, jamais d'offre à qui ne peut la
 * recevoir.
 *
 * Restaurant Zone 4, clients placés à l'est ou à l'ouest en mètres. Sans
 * tracé Google, la direction juge « sans carte » (test 6) ou « même zone ».
 * À 12 h 30 (heure de pointe, 16 km/h), 2 km à vol d'oiseau = 2,8 km de
 * route = 10 min 30 s.
 */
import { CourseStatut, DeliveryService, DeliveryStatut, OrderStatus } from '@prisma/client';

import { FIN_PAUSE_INDEFINIE } from 'src/modules/deliverers/helpers/disponibilite.rules';

import { VerdictPaire } from './direction.rules';
import {
  actionsDe,
  cmd,
  crs,
  decale,
  enPrep,
  h,
  instant,
  livr,
  plus,
  R,
  types,
} from './monde-planification.simulee-spec';
import {
  actionsRepliV1,
  allerRetourCourseMs,
  ARRET_CLIENT_S,
  classerLivreurs,
  clePaire,
  CLASSE_VERROU_PLANIFICATEUR,
  decisionTurboV2,
  estAuRestaurant,
  etasLivreurs,
  fenetreApresRetrait,
  heureProgrammee,
  lirePlanificateur,
  lireReglagesPlanification,
  margeRemiseApresRetraitMs,
  pairesAEvaluer,
  planificateurDuRestaurant,
  planifier,
  promesseCommande,
  REGLAGES_PLANIFICATION_DEFAUT,
  ReglagesPlanification,
  vitesseKmh,
} from './planification.rules';

const M = h('12:30');
const REG = REGLAGES_PLANIFICATION_DEFAUT;
const avec = (r: Partial<ReglagesPlanification>): ReglagesPlanification => ({ ...REG, ...r });
/** Attente courte seule, comme avant le 24/10 : cas du trajet long coupé. */
const COURT = avec({ attenteMaxTrajetLongS: 0 });

/** Refus noté pour une commande (ou une course absorbée) face à une course. */
function refusDe(plan: ReturnType<typeof planifier>, quoi: string, cle: string) {
  return plan.refus.filter((x) => (x.order_id === quoi || x.source_id === quoi) && x.course_cle === cle).map((x) => x.refus);
}

// ─── Réglages ────────────────────────────────────────────────────────────────

describe('réglages du planificateur', () => {
  it('défauts de la demande', () => {
    const { reglages, refusees, google } = lireReglagesPlanification({});
    expect(refusees).toEqual([]);
    expect(google).toBe(true);
    expect(reglages).toMatchObject({
      attenteMaxCommandePreteS: 300,
      horizonPreparationS: 420,
      petitRetardRetourMin: 5,
      attenteMaxTrajetLongS: 1200,
      maxCommandesParCourse: 3,
      dureeTourneeMaxMin: 25,
      promesseClientMin: 35,
      retardMaxClientMin: 5,
      detourMaxAjoutMin: 8,
      ajoutApresRetraitMaxS: 240,
      departRayonM: 250,
      turboApresMinV2: 6,
      intervalleTacheS: 10,
      retenueMemeSiLivreurLibre: false,
      ajoutApresRetrait: true,
    });
    expect(reglages.direction).toMatchObject({ couloirM: 600, zoneRayonM: 800 });
  });

  it('0 accepté là où il a un sens (contrairement au toNumber du module course)', () => {
    const { reglages, refusees } = lireReglagesPlanification({
      'course.attente_max_commande_prete_s': '0',
      'course.horizon_preparation_s': '0',
      'course.petit_retard_retour_min': '0',
      'course.attente_max_trajet_long_s': '0',
      'course.ajout_apres_retrait_max_s': '0',
      'course.retard_max_client_min': '0',
      'course.detour_max_ajout_min': '0',
      'course.turbo_fallback_after_min_v2': '0',
      'course.direction_couloir_m': '0',
    });
    expect(refusees).toEqual([]);
    expect(reglages).toMatchObject({
      attenteMaxCommandePreteS: 0,
      horizonPreparationS: 0,
      petitRetardRetourMin: 0,
      attenteMaxTrajetLongS: 0,
      ajoutApresRetraitMaxS: 0,
      retardMaxClientMin: 0,
      detourMaxAjoutMin: 0,
      turboApresMinV2: 0,
    });
    expect(reglages.direction.couloirM).toBe(0);
  });

  it('valeur refusée : défaut gardé et refus SIGNALÉ', () => {
    const { reglages, refusees } = lireReglagesPlanification({
      'course.max_orders_per_course': '0',
      'course.max_route_duration_min': '0',
      'course.vitesse_moyenne_kmh': '-3',
      'course.depart_rayon_m': 'loin',
      'course.ajout_apres_retrait': 'peut-être',
      'course.planificateur_tache_s': '2.5',
      'course.petit_retard_retour_min': '-1',
      'course.attente_max_trajet_long_s': 'vingt minutes',
    });
    expect(reglages.petitRetardRetourMin).toBe(5);
    expect(reglages.attenteMaxTrajetLongS).toBe(1200);
    expect(reglages.maxCommandesParCourse).toBe(3);
    expect(reglages.dureeTourneeMaxMin).toBe(25);
    expect(reglages.vitesseMoyenneKmh).toBe(22);
    expect(reglages.departRayonM).toBe(250);
    expect(reglages.ajoutApresRetrait).toBe(true);
    expect(reglages.intervalleTacheS).toBe(10);
    expect(refusees.map((x) => x.cle).sort()).toEqual(
      [
        'course.ajout_apres_retrait',
        'course.depart_rayon_m',
        'course.max_orders_per_course',
        'course.max_route_duration_min',
        'course.planificateur_tache_s',
        'course.vitesse_moyenne_kmh',
        'course.petit_retard_retour_min',
        'course.attente_max_trajet_long_s',
      ].sort(),
    );
  });

  it('booléens et virgule décimale', () => {
    const { reglages } = lireReglagesPlanification({
      'course.retenue_meme_si_livreur_libre': 'oui',
      'course.turbo_fallback_enabled': '0',
      'course.vitesse_pointe_kmh': '15,5',
    });
    expect(reglages.retenueMemeSiLivreurLibre).toBe(true);
    expect(reglages.turboActif).toBe(false);
    expect(reglages.vitessePointeKmh).toBe(15.5);
  });

  it('verrou du planificateur : classe distincte de 727224 à 727228', () => {
    expect(CLASSE_VERROU_PLANIFICATEUR).toBe(727229);
  });
});

describe('choix du planificateur : v2 par défaut, v1 en repli', () => {
  it('v2 pour tous sans réglage', () => {
    const lu = lirePlanificateur({});
    expect(lu).toEqual({ version: 'v2', restaurants: [], refusees: [] });
    expect(planificateurDuRestaurant(lu, 'r1')).toBe('v2');
  });

  it('v1 partout quand demandé', () => {
    const lu = lirePlanificateur({ 'course.planificateur': 'v1', 'course.planificateur_restaurants': 'r1' });
    expect(planificateurDuRestaurant(lu, 'r1')).toBe('v1');
    expect(planificateurDuRestaurant(lu, 'r2')).toBe('v1');
  });

  it('liste de restaurants : v2 seulement pour eux (virgules, espaces ou tableau JSON)', () => {
    for (const liste of ['r1, r3', 'r1 r3', '["r1","r3"]']) {
      const lu = lirePlanificateur({ 'course.planificateur': 'v2', 'course.planificateur_restaurants': liste });
      expect(planificateurDuRestaurant(lu, 'r1')).toBe('v2');
      expect(planificateurDuRestaurant(lu, 'r2')).toBe('v1');
      expect(planificateurDuRestaurant(lu, 'r3')).toBe('v2');
    }
  });

  it('valeur inconnue : v2 gardé, refus signalé', () => {
    const lu = lirePlanificateur({ 'course.planificateur': 'v3', 'course.planificateur_restaurants': '[1,2' });
    expect(lu.version).toBe('v2');
    expect(lu.refusees.map((x) => x.cle)).toEqual(['course.planificateur', 'course.planificateur_restaurants']);
  });
});

// ─── Petites règles ──────────────────────────────────────────────────────────

describe('promesse au client et heure de pointe', () => {
  it('created_at + 35 min ; commande programmée plus tard : heure convenue + 10 min', () => {
    expect(promesseCommande({ created_at: h('12:15'), heure_programmee: null }, REG)).toEqual(h('12:50'));
    expect(promesseCommande({ created_at: h('12:15'), heure_programmee: h('13:30') }, REG)).toEqual(h('13:40'));
    // heure « convenue » déjà passée (commande ordinaire datée) : la promesse ordinaire
    expect(promesseCommande({ created_at: h('12:15'), heure_programmee: h('12:15') }, REG)).toEqual(h('12:50'));
  });

  it('heure convenue lue dans date + time', () => {
    const jour = new Date('2026-10-23T00:00:00.000Z');
    expect(heureProgrammee(jour, '13:30')).toEqual(h('13:30'));
    expect(heureProgrammee(jour, '9h05')).toEqual(h('09:05'));
    expect(heureProgrammee(jour, 'midi')).toBeNull();
    expect(heureProgrammee(null, '13:30')).toBeNull();
    expect(heureProgrammee(jour, '25:00')).toBeNull();
  });

  it('vitesse : 16 km/h de 11 h 30 à 14 h 30 et de 18 h 30 à 22 h, 22 km/h sinon', () => {
    expect(vitesseKmh(h('12:30'), REG)).toBe(16);
    expect(vitesseKmh(h('11:29'), REG)).toBe(22);
    expect(vitesseKmh(h('16:00'), REG)).toBe(22);
    expect(vitesseKmh(h('19:00'), REG)).toBe(16);
    expect(vitesseKmh(h('22:00'), REG)).toBe(22);
  });
});

describe('livreur au comptoir et temps jusqu’au comptoir (4.2)', () => {
  it('au restaurant : à moins de 200 m, position de moins de 15 min', () => {
    expect(estAuRestaurant({ position: decale(R, 0, 150), position_at: plus(M, -14 * 60) }, R, REG, M)).toBe(true);
    expect(estAuRestaurant({ position: decale(R, 0, 250), position_at: plus(M, -60) }, R, REG, M)).toBe(false);
    expect(estAuRestaurant({ position: R, position_at: plus(M, -16 * 60) }, R, REG, M)).toBe(false);
    expect(estAuRestaurant({ position: R, position_at: M }, null, REG, M)).toBe(false);
  });

  it('comptoir 0, vol d’oiseau × 1,3 à la vitesse du moment, défaut 8 min sans position fraîche', () => {
    const etas = etasLivreurs(
      [
        livr('comptoir', M, { auComptoir: true }),
        livr('loin', M, { aEst: 2000 }),
        livr('perime', M, { aEst: 2000, position_at: plus(M, -6 * 60) }),
        livr('inconnu', M),
      ],
      R,
      REG,
      M,
    );
    expect(etas.get('comptoir')).toEqual({ secondes: 0, source: 'COMPTOIR', au_comptoir: true });
    expect(etas.get('loin')!.source).toBe('VOL_OISEAU');
    expect(etas.get('loin')!.secondes).toBeCloseTo((2000 * 1.3) / (16 / 3.6), 0);
    expect(etas.get('perime')).toEqual({ secondes: 480, source: 'DEFAUT', au_comptoir: false });
    expect(etas.get('inconnu')).toEqual({ secondes: 480, source: 'DEFAUT', au_comptoir: false });
  });

  it('temps Google seulement s’il est connu pour TOUS : jamais de mélange avec le vol d’oiseau', () => {
    const tous = etasLivreurs(
      [livr('a', M, { aEst: 2000, secondes_google: 300 }), livr('b', M, { aEst: 3000, secondes_google: 500 })],
      R,
      REG,
      M,
    );
    expect(tous.get('a')).toMatchObject({ secondes: 300, source: 'GOOGLE' });
    expect(tous.get('b')).toMatchObject({ secondes: 500, source: 'GOOGLE' });
    const melange = etasLivreurs(
      [livr('a', M, { aEst: 2000, secondes_google: 300 }), livr('b', M, { aEst: 3000 })],
      R,
      REG,
      M,
    );
    expect(melange.get('a')!.source).toBe('VOL_OISEAU');
    expect(melange.get('b')!.source).toBe('VOL_OISEAU');
  });
});

describe('choix du livreur en minutes (4.2)', () => {
  const classer = (livreurs: ReturnType<typeof livr>[]) =>
    classerLivreurs(livreurs, livreurs, etasLivreurs(livreurs, R, REG, M), M).map((c) => c.deliverer_id);

  it('au comptoir d’abord, même au fond de la file', () => {
    expect(
      classer([
        livr('proche', M, { aEst: 600, etat: { last_available_at: h('11:00') } }),
        livr('comptoir', M, { auComptoir: true, etat: { last_available_at: h('12:25') } }),
      ]),
    ).toEqual(['comptoir', 'proche']);
  });

  it('bonus de file : rang 1 avant rang 2', () => {
    expect(
      classer([
        livr('deuxieme', M, { auComptoir: true, etat: { last_available_at: h('12:10') } }),
        livr('premier', M, { auComptoir: true, etat: { last_available_at: h('12:00') } }),
      ]),
    ).toEqual(['premier', 'deuxieme']);
  });

  it('pénalité de refus active : une minute par place', () => {
    const livreurs = [
      livr('premier', M, {
        auComptoir: true,
        etat: { last_available_at: h('12:00') },
        queue_penalty_until: plus(M, 300),
        queue_penalty_positions: 3,
      }),
      livr('deuxieme', M, { auComptoir: true, etat: { last_available_at: h('12:10') } }),
    ];
    expect(classer(livreurs)).toEqual(['deuxieme', 'premier']);
    const couts = classerLivreurs(livreurs, livreurs, etasLivreurs(livreurs, R, REG, M), M);
    expect(couts.find((c) => c.deliverer_id === 'premier')).toMatchObject({ bonus_file_min: 3, penalite_min: 3, cout_min: 0 });
    // pénalité échue : sans effet
    livreurs[0].queue_penalty_until = plus(M, -1);
    expect(classer(livreurs)).toEqual(['premier', 'deuxieme']);
  });

  it('équité : une demi-minute par course du jour au-dessus de la moyenne', () => {
    expect(
      classer([
        livr('charge', M, { auComptoir: true, etat: { last_available_at: h('12:00') }, courses_du_jour: 8 }),
        livr('repose', M, { auComptoir: true, etat: { last_available_at: h('12:10') }, courses_du_jour: 0 }),
      ]),
    ).toEqual(['repose', 'charge']); // charge : −3 + 2 = −1 ; repose : −1,5 − 2 = −3,5
  });

  it('à égalité de coût, la file (FIFO)', () => {
    const tous = [
      livr('l1', M, { auComptoir: true, etat: { last_available_at: h('11:00') } }),
      livr('l2', M, { auComptoir: true, etat: { last_available_at: h('11:10') } }),
      livr('l4', M, { auComptoir: true, etat: { last_available_at: h('11:30') } }),
      livr('l3', M, { auComptoir: true, etat: { last_available_at: h('11:20') } }),
    ];
    expect(classer(tous)).toEqual(['l1', 'l2', 'l3', 'l4']);
  });
});

describe('fenêtre d’ajout après le retrait (3.8)', () => {
  const recuperee = (o: Parameters<typeof crs>[1] = {}) =>
    crs('k', {
      statut: CourseStatut.IN_DELIVERY,
      deliverer_id: 'd1',
      picked_up_at: h('12:30'),
      commandes: [cmd('a', { statut: OrderStatus.PICKED_UP })],
      ...o,
    });
  const lui = (o: Parameters<typeof livr>[2] = {}) => livr('d1', h('12:31'), { auComptoir: true, ...o });

  it('ouverte : nouvelle appli, au comptoir, moins de 240 s après le retrait', () => {
    expect(fenetreApresRetrait(recuperee(), lui(), R, REG, h('12:32'))).toEqual({ ouverte: true, ferme_a: h('12:34') });
  });

  it.each([
    ['DEJA_PARTI', () => fenetreApresRetrait(recuperee({ parti_at: h('12:31') }), lui(), R, REG, h('12:32'))],
    ['AJOUT_COUPE', () => fenetreApresRetrait(recuperee(), lui(), R, avec({ ajoutApresRetrait: false }), h('12:32'))],
    ['ANCIENNE_APPLI', () => fenetreApresRetrait(recuperee(), lui({ protocole_appli: 2 }), R, REG, h('12:32'))],
    ['ANCIENNE_APPLI', () => fenetreApresRetrait(recuperee(), lui({ protocole_appli: null }), R, REG, h('12:32'))],
    ['SANS_RETRAIT', () => fenetreApresRetrait(recuperee({ picked_up_at: null }), lui(), R, REG, h('12:32'))],
    [
      'LIVRAISON_DEMARREE',
      () =>
        fenetreApresRetrait(
          recuperee({
            livraisons: [
              { id: 'l', statut: DeliveryStatut.IN_ROUTE, sequence_order: 1, commande: cmd('a', { statut: OrderStatus.PICKED_UP }) },
            ],
          }),
          lui(),
          R,
          REG,
          h('12:32'),
        ),
    ],
    [
      'POSITION',
      () => fenetreApresRetrait(recuperee(), lui({ auComptoir: false, position: decale(R, 0, 300), position_at: h('12:31:30') }), R, REG, h('12:32')),
    ],
    ['FENETRE_ECHUE', () => fenetreApresRetrait(recuperee(), lui(), R, REG, h('12:34'))],
    ['FENETRE_ECHUE', () => fenetreApresRetrait(recuperee(), lui(), R, avec({ ajoutApresRetraitMaxS: 0 }), h('12:30'))],
  ])('fermée : %s', (motif, f) => {
    expect(f()).toEqual({ ouverte: false, motif });
  });

  it('une position lointaine d’AVANT le retrait ne dit pas qu’il est parti', () => {
    const d = lui({ auComptoir: false, position: decale(R, 0, 2000), position_at: h('12:25') });
    expect(fenetreApresRetrait(recuperee(), d, R, REG, h('12:32')).ouverte).toBe(true);
  });
});

describe('Turbo sous v2 (3.11)', () => {
  const enAttente = (o: Parameters<typeof crs>[1] = {}) =>
    crs('k', { created_at: h('12:28'), commandes: [cmd('a', { ready_at: h('12:24') })], ...o });

  it('compté depuis la plus ancienne commande prête, pas depuis la création de la course', () => {
    expect(decisionTurboV2(enAttente(), REG, h('12:29:59')).basculer).toBe(false);
    const d = decisionTurboV2(enAttente(), REG, h('12:30'));
    expect(d).toMatchObject({ basculer: true, minutes: 6, depuis: h('12:24') });
  });

  it('jamais pendant une offre en attente, ni coupé, ni Turbo d’origine, ni déjà confiée', () => {
    expect(decisionTurboV2(enAttente({ offre: { id: 'o', deliverer_id: 'd', expires_at: h('12:31') } }), REG, h('12:31')).basculer).toBe(false);
    expect(decisionTurboV2(enAttente(), avec({ turboActif: false }), h('12:40')).basculer).toBe(false);
    expect(
      decisionTurboV2(enAttente({ commandes: [cmd('a', { ready_at: h('12:24'), delivery_service: DeliveryService.TURBO })] }), REG, h('12:40'))
        .basculer,
    ).toBe(false);
    expect(decisionTurboV2(enAttente({ turbo_escalated_at: h('12:35') }), REG, h('12:40')).basculer).toBe(false);
    expect(decisionTurboV2(enAttente({ statut: CourseStatut.ACCEPTED, deliverer_id: 'd' }), REG, h('12:40')).basculer).toBe(false);
  });

  it('0 minute : dès qu’aucun livreur n’est libre', () => {
    expect(decisionTurboV2(enAttente(), avec({ turboApresMinV2: 0 }), h('12:24')).basculer).toBe(true);
  });
});

// ─── planifier : création et ajout ───────────────────────────────────────────

describe('commande prête : création immédiate, sans lot', () => {
  it('course créée tout de suite et offerte au livreur au comptoir', () => {
    const plan = planifier(instant(M, { commandes: [cmd('a')], livreurs: [livr('d1', M, { auComptoir: true })] }));
    expect(types(plan)).toEqual(['CREER_COURSE', 'OFFRIR']);
    expect(actionsDe(plan, 'CREER_COURSE')[0]).toMatchObject({ cle: 'nouvelle-1', order_ids: ['a'], sequence: ['a'] });
    expect(actionsDe(plan, 'OFFRIR')[0]).toMatchObject({ course_cle: 'nouvelle-1', course_id: null, deliverer_id: 'd1' });
    expect(actionsDe(plan, 'OFFRIR')[0].cout.au_comptoir).toBe(true);
  });

  it('sans livreur libre : la course est créée et attend, sans offre', () => {
    const plan = planifier(instant(M, { commandes: [cmd('a')] }));
    expect(types(plan)).toEqual(['CREER_COURSE']);
  });

  it('regroupement glouton de commandes prêtes de la même direction ; les sens opposés à part', () => {
    const plan = planifier(
      instant(M, { commandes: [cmd('a', { est: 2000 }), cmd('b', { est: 1000 }), cmd('c', { est: -2000 })] }),
    );
    const creees = actionsDe(plan, 'CREER_COURSE');
    expect(creees).toHaveLength(2);
    expect(creees[0]).toMatchObject({ sequence: ['b', 'a'], motif: 'SANS_CARTE' });
    expect([...creees[0].order_ids].sort()).toEqual(['a', 'b']);
    expect(creees[1]).toMatchObject({ order_ids: ['c'] });
    expect(refusDe(plan, 'c', 'nouvelle-1')).toEqual(['DIRECTION']);
  });

  it('commande sans coordonnées : toujours seule', () => {
    const plan = planifier(instant(M, { commandes: [cmd('a', { sansCoordonnees: true }), cmd('b')] }));
    expect(actionsDe(plan, 'CREER_COURSE').map((a) => a.order_ids)).toEqual([['a'], ['b']]);
  });

  it('seules les commandes de la flotte interne sont planifiées', () => {
    const plan = planifier(instant(M, { commandes: [cmd('a', { delivery_service: DeliveryService.TURBO })] }));
    expect(plan.actions).toEqual([]);
  });

  it('idempotent : une commande déjà dans une course n’est jamais recréée', () => {
    const a = cmd('a');
    const plan = planifier(instant(M, { commandes: [a], courses: [crs('k', { commandes: [a] })] }));
    expect(actionsDe(plan, 'CREER_COURSE')).toEqual([]);
    expect(actionsDe(plan, 'AJOUTER')).toEqual([]);
  });
});

describe('commande prête : ajout à la meilleure course ouverte (3.4)', () => {
  const q = () => cmd('q', { est: 2300 });
  const ouvertes = () => ({
    enLivraison: crs('k-in', {
      statut: CourseStatut.IN_DELIVERY,
      deliverer_id: 'd-in',
      picked_up_at: h('12:29'),
      commandes: [cmd('o1', { statut: OrderStatus.PICKED_UP })],
    }),
    auComptoir: crs('k-at', { statut: CourseStatut.AT_RESTAURANT, deliverer_id: 'd-at', commandes: [cmd('o2')] }),
    enRoute: crs('k-acc', { statut: CourseStatut.ACCEPTED, deliverer_id: 'd-acc', commandes: [cmd('o3')] }),
    sansLivreur: crs('k-pen', { commandes: [cmd('o4')] }),
  });
  const livreurs = () => [
    livr('d-in', M, { auComptoir: true, etat: { en_course: true, last_available_at: null } }),
    livr('d-at', M, { auComptoir: true, etat: { en_course: true, last_available_at: null } }),
    livr('d-acc', M, { aEst: 1500, etat: { en_course: true, last_available_at: null } }),
  ];

  it.each([
    ['k-in', ['enLivraison', 'auComptoir', 'enRoute', 'sansLivreur']],
    ['k-at', ['auComptoir', 'enRoute', 'sansLivreur']],
    ['k-acc', ['enRoute', 'sansLivreur']],
    ['k-pen', ['sansLivreur']],
  ] as const)('préférence : %s', (attendu, presentes) => {
    const k = ouvertes();
    const plan = planifier(instant(M, { commandes: [q()], courses: presentes.map((p) => k[p]), livreurs: livreurs() }));
    const ajouts = actionsDe(plan, 'AJOUTER');
    expect(ajouts).toHaveLength(1);
    expect(ajouts[0]).toMatchObject({ course_id: attendu, order_id: 'q', apres_retrait: attendu === 'k-in' });
    expect(actionsDe(plan, 'CREER_COURSE')).toEqual([]);
  });

  it('la course qui l’attendait d’abord, puis sa retenue levée : « tout est prêt »', () => {
    const k = ouvertes();
    const enRoute = { ...k.enRoute, retenue_jusqua: h('12:33'), commandes_attendues: ['q'] };
    const plan = planifier(instant(M, { commandes: [q()], courses: [k.auComptoir, enRoute], livreurs: livreurs() }));
    expect(actionsDe(plan, 'AJOUTER')[0]).toMatchObject({ course_id: 'k-acc', attendue: true });
    expect(actionsDe(plan, 'LIBERER')).toEqual([expect.objectContaining({ course_id: 'k-acc', motif: 'TOUT_PRET', jusqua: M })]);
  });

  it('ajout à une course en recherche avec offre : l’offre est rendue pour être réémise à jour', () => {
    const offre = { id: 'offre-1', deliverer_id: 'd9', expires_at: h('12:31') };
    const k = { ...ouvertes().sansLivreur, offre };
    const plan = planifier(instant(M, { commandes: [q()], courses: [k], livreurs: [livr('d9', M, { aEst: 1000, etat: { offre_en_attente: true } })] }));
    expect(actionsDe(plan, 'AJOUTER')[0]).toMatchObject({ course_id: 'k-pen', offre });
    expect(actionsDe(plan, 'OFFRIR')).toEqual([]);
  });

  it('jamais vers une course confiée à Turbo, Turbo d’origine, ou d’un livreur en pause', () => {
    const turbo = crs('k-turbo', { turbo_escalated_at: h('12:20'), commandes: [cmd('o1')] });
    const origine = crs('k-orig', { commandes: [cmd('o2', { delivery_service: DeliveryService.TURBO })] });
    const enPause = crs('k-pause', { statut: CourseStatut.AT_RESTAURANT, deliverer_id: 'd-p', commandes: [cmd('o3')] });
    const pauseAuto = crs('k-auto', { statut: CourseStatut.ACCEPTED, deliverer_id: 'd-a', commandes: [cmd('o4')] });
    const plan = planifier(
      instant(M, {
        commandes: [q()],
        courses: [turbo, origine, enPause, pauseAuto],
        livreurs: [
          livr('d-p', M, { auComptoir: true, etat: { en_course: true, pause_until: FIN_PAUSE_INDEFINIE } }),
          livr('d-a', M, { aEst: 500, etat: { en_course: true, auto_pause_until: plus(M, 600) } }),
        ],
      }),
    );
    expect(actionsDe(plan, 'AJOUTER')).toEqual([]);
    expect(actionsDe(plan, 'FUSIONNER')).toEqual([]);
    expect(actionsDe(plan, 'CREER_COURSE')[0].order_ids).toEqual(['q']);
    expect(actionsDe(plan, 'CONFIER_TURBO')).toEqual([]);
  });

  it('ordre des arrêts recalculé : le plus proche sur le trajet d’abord', () => {
    const k = crs('k', { statut: CourseStatut.AT_RESTAURANT, deliverer_id: 'd1', commandes: [cmd('a', { est: 3000 })] });
    const plan = planifier(
      instant(M, {
        commandes: [cmd('q', { est: 1000 })],
        courses: [k],
        livreurs: [livr('d1', M, { auComptoir: true, etat: { en_course: true } })],
      }),
    );
    expect(types(plan)).toEqual(['AJOUTER', 'ORDONNER']);
    expect(actionsDe(plan, 'ORDONNER')[0]).toEqual({ type: 'ORDONNER', course_id: 'k', sequence: ['q', 'a'] });
  });
});

// ─── Les limites de 3.6, une à la fois ───────────────────────────────────────

describe('limites dures d’un ajout (3.6)', () => {
  const auComptoir = (commandes: ReturnType<typeof cmd>[]) =>
    crs('k', { statut: CourseStatut.AT_RESTAURANT, deliverer_id: 'd1', commandes });
  const d1 = () => livr('d1', M, { auComptoir: true, etat: { en_course: true, last_available_at: null } });
  const essai = (k: ReturnType<typeof crs>, q: ReturnType<typeof cmd>, reglages = REG, autres: ReturnType<typeof livr>[] = []) =>
    planifier(instant(M, { commandes: [q], courses: [k], livreurs: [d1(), ...autres] }), reglages);

  it('taille : jamais plus de 3 commandes (annulées non comptées)', () => {
    const pleine = auComptoir([cmd('o1', { est: 2000 }), cmd('o2', { est: 2100 }), cmd('o3', { est: 2200 })]);
    const plan = essai(pleine, cmd('q', { est: 2300 }));
    expect(actionsDe(plan, 'AJOUTER')).toEqual([]);
    expect(refusDe(plan, 'q', 'k')).toEqual(['TAILLE']);

    const avecAnnulee = crs('k', {
      statut: CourseStatut.AT_RESTAURANT,
      deliverer_id: 'd1',
      livraisons: [
        { id: 'l1', statut: DeliveryStatut.PENDING, sequence_order: 1, commande: cmd('o1', { est: 2000 }) },
        { id: 'l2', statut: DeliveryStatut.PENDING, sequence_order: 2, commande: cmd('o2', { est: 2100 }) },
        { id: 'l3', statut: DeliveryStatut.CANCELLED, sequence_order: 3, commande: cmd('o3', { est: 2200 }) },
      ],
    });
    expect(actionsDe(essai(avecAnnulee, cmd('q', { est: 2300 })), 'AJOUTER')).toHaveLength(1);
  });

  it('direction : sens opposés refusés', () => {
    const plan = essai(auComptoir([cmd('o', { est: -2000 })]), cmd('q', { est: 2000 }));
    expect(actionsDe(plan, 'AJOUTER')).toEqual([]);
    expect(refusDe(plan, 'q', 'k')).toEqual(['DIRECTION']);
  });

  it('durée de tournée : restaurant → dernier client, arrêts compris', () => {
    const k = auComptoir([cmd('o', { est: 2000 })]);
    // 10 min 30 + 3 min + 1 min 35 = 15 min 5 s
    expect(refusDe(essai(k, cmd('q', { est: 2300 }), avec({ dureeTourneeMaxMin: 15 })), 'q', 'k')).toEqual(['DUREE_TOURNEE']);
    expect(actionsDe(essai(k, cmd('q', { est: 2300 }), avec({ dureeTourneeMaxMin: 16 })), 'AJOUTER')).toHaveLength(1);
  });

  it('détour imposé à une commande déjà prévue : au plus 8 min (ici 3 min : un arrêt de plus)', () => {
    const k = auComptoir([cmd('o', { est: 3000 })]);
    const q = cmd('q', { est: 1500 });
    expect(refusDe(essai(k, q, avec({ detourMaxAjoutMin: 2 })), 'q', 'k')).toEqual(['DETOUR_AJOUT']);
    expect(actionsDe(essai(k, q), 'AJOUTER')[0]).toMatchObject({ detour_s: ARRET_CLIENT_S });
  });

  it('retard : une commande déjà prévue n’est jamais poussée au-delà de sa promesse + 5 min', () => {
    // o promise 12:36, limite 12:41 ; seule elle arrive à 12:40:30 ; avec q avant elle, 12:43:30.
    // q aussi pressée (créée à 12:01) : la livrer après o la mettrait en retard à son tour,
    // aucun ordre ne sauve les deux (l'ordre selon les promesses est testé à part).
    const k = auComptoir([cmd('o', { est: 2000, created_at: h('12:01') })]);
    const q = cmd('q', { est: 1000, created_at: h('12:01') });
    const plan = essai(k, q);
    expect(actionsDe(plan, 'AJOUTER')).toEqual([]);
    expect(refusDe(plan, 'q', 'k')).toEqual(['RETARD_CLIENT']);
    // retard toléré plus large : accepté
    expect(actionsDe(essai(k, q, avec({ retardMaxClientMin: 8 })), 'AJOUTER')).toHaveLength(1);
  });

  it('personne pour partir : le retard supposé d’une commande prévue ne bloque pas le regroupement (le détour, si)', () => {
    // Même géométrie que ci-dessus, mais course sans livreur et aucun livreur libre : le départ n'est qu'une supposition.
    const attend = crs('k', { commandes: [cmd('o', { est: 2000, created_at: h('12:01') })] });
    const q = cmd('q', { est: 1000, created_at: h('12:01') });
    expect(actionsDe(planifier(instant(M, { commandes: [q], courses: [attend] })), 'AJOUTER')).toHaveLength(1);
    expect(refusDe(planifier(instant(M, { commandes: [q], courses: [attend] }), avec({ detourMaxAjoutMin: 2 })), 'q', 'k')).toEqual([
      'DETOUR_AJOUT',
    ]);
    // Un livreur libre au comptoir : le départ est connu, la règle du retard joue.
    const plan = planifier(instant(M, { commandes: [q], courses: [attend], livreurs: [livr('d2', M, { auComptoir: true })] }));
    expect(refusDe(plan, 'q', 'k')).toEqual(['RETARD_CLIENT']);
  });

  it('retard de la commande ajoutée : refusé si un livreur libre la livrerait plus tôt seule, accepté sinon', () => {
    // q promise 12:35, limite 12:40 : en retard de toute façon ; seule elle arrive à 12:45:45, après o à 12:48:45
    const k = auComptoir([cmd('o', { est: 1500 })]);
    const q = cmd('q', { est: 3000, created_at: h('12:00') });
    const libre = livr('d2', M, { auComptoir: true });
    const plan = essai(k, q, REG, [libre]);
    expect(refusDe(plan, 'q', 'k')).toEqual(['RETARD_CLIENT']);
    expect(actionsDe(plan, 'OFFRIR')[0]).toMatchObject({ deliverer_id: 'd2', course_cle: 'nouvelle-1' });
    expect(actionsDe(essai(k, q), 'AJOUTER')).toHaveLength(1);
  });

  it('attente au comptoir : pas plus de 5 min derrière un livreur en route si un livreur libre peut partir', () => {
    const enRoute = crs('k', { statut: CourseStatut.ACCEPTED, deliverer_id: 'd1', commandes: [cmd('o', { est: 2000 })] });
    const loin = livr('d1', M, { aEst: 2500, etat: { en_course: true, last_available_at: null } }); // 12 min
    const libre = livr('d2', M, { auComptoir: true });
    const q = cmd('q', { est: 2300, created_at: h('12:28') }); // promesse large : seule l'attente joue
    const plan = planifier(instant(M, { commandes: [q], courses: [enRoute], livreurs: [loin, libre] }));
    expect(refusDe(plan, 'q', 'k')).toEqual(['ATTENTE_COMMANDE_PRETE']);
    expect(types(plan)).toEqual(['CREER_COURSE', 'OFFRIR']);
    // personne d'autre : attendre le livreur en route vaut mieux que rien
    const seul = planifier(instant(M, { commandes: [q], courses: [enRoute], livreurs: [loin] }));
    expect(actionsDe(seul, 'AJOUTER')[0]).toMatchObject({ course_id: 'k' });
  });

  it('jamais de mélange mètres routiers / vol d’oiseau : détour comparé sur la même base', () => {
    // o a un tracé routier (base « route »), q n'en a pas : le groupe est jugé à vol d'oiseau,
    // donc o seule aussi (détour = 300 m × 1,4 + un arrêt), jamais 2 000 m routiers contre 2 800 m redressés.
    const o = cmd('o', { est: 2000 });
    o.client = { ...o.client, trace: [R, o.client.position!], routeMetres: 2000 };
    const plan = essai(auComptoir([o]), cmd('q', { est: 2300 }));
    const ajout = actionsDe(plan, 'AJOUTER')[0];
    expect(ajout.detour_s).toBeGreaterThanOrEqual(274);
    expect(ajout.detour_s).toBeLessThanOrEqual(275);
  });

  it('verdicts de direction fournis par le service (Google) : ils l’emportent sur le repli', () => {
    const k = auComptoir([cmd('o', { est: 2000 })]);
    const dementi: VerdictPaire = {
      compatible: false,
      motif: 'DETOUR_TROP_LONG',
      test: 5,
      libelle: 'détour de 9 min, trop long',
      procheId: 'o',
      lointainId: 'q',
      classement: 'route',
      ecartCapDeg: 0,
      distanceAuTraceM: 900,
      detourSecondes: 540,
      versLointain: false,
      memeZone: false,
    };
    const plan = planifier(instant(M, { commandes: [cmd('q', { est: 2300 })], courses: [k], livreurs: [d1()] }), REG, {
      verdicts: new Map([[clePaire('q', 'o'), dementi]]),
    });
    expect(actionsDe(plan, 'AJOUTER')).toEqual([]);
    expect(plan.refus.find((x) => x.order_id === 'q')).toMatchObject({ refus: 'DIRECTION', libelle: 'détour de 9 min, trop long' });
  });
});

// ─── Retenue au comptoir (3.5) ───────────────────────────────────────────────

describe('retenue au comptoir : une commande prête attend une commande en préparation', () => {
  const T0 = h('12:30:10');
  /** D1 au comptoir avec A (prête à 12:30, 2,5 km est) ; B en préparation (2 km est). */
  const base = (o: {
    finB?: Date;
    readyA?: Date;
    retenue?: Date | null;
    attendues?: string[];
    autres?: ReturnType<typeof livr>[];
    coursesEnPlus?: ReturnType<typeof crs>[];
    enPlus?: ReturnType<typeof cmd>[];
    maintenant?: Date;
    statut?: CourseStatut;
    d1?: Parameters<typeof livr>[2];
    reglages?: ReglagesPlanification;
  } = {}) => {
    const maintenant = o.maintenant ?? T0;
    const a = cmd('a', { est: 2500, created_at: h('12:18'), ready_at: o.readyA ?? h('12:30') });
    const k = crs('k', {
      statut: o.statut ?? CourseStatut.AT_RESTAURANT,
      deliverer_id: 'd1',
      commandes: [a],
      retenue_jusqua: o.retenue ?? null,
      commandes_attendues: o.attendues ?? [],
    });
    const b = enPrep('b', o.finB ?? h('12:33'), { est: 2000, created_at: h('12:20') });
    return planifier(
      instant(maintenant, {
        commandes: [b, ...(o.enPlus ?? [])],
        courses: [k, ...(o.coursesEnPlus ?? [])],
        livreurs: [livr('d1', maintenant, { auComptoir: true, etat: { en_course: true, last_available_at: null }, ...o.d1 }), ...(o.autres ?? [])],
      }),
      o.reglages ?? REG,
    );
  };

  it('posée : la course attend B jusqu’à sa fin estimée (dans la limite)', () => {
    const plan = base();
    expect(types(plan)).toEqual(['RETENIR']);
    expect(actionsDe(plan, 'RETENIR')[0]).toMatchObject({
      course_id: 'k',
      jusqua: h('12:33'),
      attendues: [
        { order_id: 'b', reference: 'CMD-B', prete_vers: h('12:33'), prete_au_plus_tard: h('12:33'), motif: 'ATTENTE_COURTE' },
      ],
      motif: 'ATTENTE_COURTE',
      libelle: 'Attendre CMD-B (prête vers 12 h 33), départ au plus tard 12 h 33',
    });
  });

  it('horizon : pas d’attente courte d’une commande prête dans plus de 7 min', () => {
    const plan = base({ finB: h('12:38'), reglages: COURT });
    expect(actionsDe(plan, 'RETENIR')).toEqual([]);
    expect(refusDe(plan, 'b', 'k')).toEqual(['HORIZON']);
    // Avec le trajet long (défaut) : A à 2,5 km, aller-retour de 29 min, bien
    // plus que 8 min + 5 : B est attendue au-delà de l'horizon.
    expect(actionsDe(base({ finB: h('12:38') }), 'RETENIR')).toEqual([
      expect.objectContaining({ jusqua: h('12:38'), motif: 'TRAJET_LONG' }),
    ]);
  });

  it('limite : jamais d’attente courte au-delà de ready_at + 5 min de la commande prête', () => {
    const plan = base({ readyA: h('12:27'), reglages: COURT }); // limite 12:32 < fin de B 12:33
    expect(actionsDe(plan, 'RETENIR')).toEqual([]);
    expect(refusDe(plan, 'b', 'k')).toEqual(['LIMITE_RETENUE']);
    expect(actionsDe(base({ reglages: avec({ attenteMaxCommandePreteS: 0, attenteMaxTrajetLongS: 0 }) }), 'RETENIR')).toEqual([]);
    // Avec le trajet long (défaut) : A attend jusqu'à 12 h 33, 6 min, permis jusqu'à 20 min.
    expect(actionsDe(base({ readyA: h('12:27') }), 'RETENIR')).toEqual([
      expect.objectContaining({ jusqua: h('12:33'), motif: 'TRAJET_LONG' }),
    ]);
  });

  it('jamais repoussée : une commande arrivée ensuite, prête plus tard, ne l’allonge pas', () => {
    const c = enPrep('c', h('12:34'), { est: 2200, created_at: h('12:21') });
    const plan = base({ retenue: h('12:33'), attendues: ['b'], enPlus: [c], maintenant: h('12:31') });
    expect(plan.actions).toEqual([]); // rien ne change : 12:33 pour B
    expect(refusDe(plan, 'c', 'k')).toEqual(['LIMITE_RETENUE']);
  });

  it('réduite : une commande attendue disparaît, la retenue descend à la suivante', () => {
    const plan = base({ retenue: h('12:34'), attendues: ['b', 'c'], maintenant: h('12:31') });
    expect(actionsDe(plan, 'RETENIR')).toEqual([
      expect.objectContaining({ jusqua: h('12:33'), attendues: [expect.objectContaining({ order_id: 'b' })] }),
    ]);
  });

  it('levée quand tout est prêt : B prête est ajoutée dans la seconde', () => {
    const maintenant = h('12:32:50');
    const a = cmd('a', { est: 2500, created_at: h('12:18') });
    const k = crs('k', {
      statut: CourseStatut.AT_RESTAURANT,
      deliverer_id: 'd1',
      commandes: [a],
      retenue_jusqua: h('12:33'),
      commandes_attendues: ['b'],
    });
    const b = cmd('b', { est: 2000, created_at: h('12:20'), ready_at: maintenant });
    const plan = planifier(
      instant(maintenant, {
        commandes: [b],
        courses: [k],
        livreurs: [livr('d1', maintenant, { auComptoir: true, etat: { en_course: true } })],
      }),
    );
    expect(types(plan)).toEqual(['AJOUTER', 'ORDONNER', 'LIBERER']);
    expect(actionsDe(plan, 'AJOUTER')[0]).toMatchObject({ order_id: 'b', attendue: true });
    expect(actionsDe(plan, 'ORDONNER')[0].sequence).toEqual(['b', 'a']);
    expect(actionsDe(plan, 'LIBERER')[0]).toMatchObject({ motif: 'TOUT_PRET', libelle: 'Tout est prêt', jusqua: maintenant });
  });

  it('levée à l’échéance, même si B n’est pas prête', () => {
    const plan = base({ retenue: h('12:33'), attendues: ['b'], maintenant: h('12:33:05') });
    expect(actionsDe(plan, 'LIBERER')).toEqual([expect.objectContaining({ motif: 'ECHEANCE', jusqua: h('12:33') })]);
    expect(actionsDe(plan, 'RETENIR')).toEqual([]);
  });

  it('levée, elle ne revient jamais sur la même course', () => {
    const plan = base({ retenue: h('12:31'), attendues: [], maintenant: h('12:31:30') });
    expect(plan.actions).toEqual([]);
  });

  it('autre livreur libre : pas de retenue (sauf réglage contraire)', () => {
    const d2 = livr('d2', T0, { auComptoir: true });
    const plan = base({ autres: [d2] });
    expect(actionsDe(plan, 'RETENIR')).toEqual([]);
    expect(refusDe(plan, 'b', 'k')).toEqual(['AUTRE_LIVREUR_LIBRE']);
    expect(actionsDe(base({ autres: [d2], reglages: avec({ retenueMemeSiLivreurLibre: true }) }), 'RETENIR')).toHaveLength(1);
  });

  it('autre livreur de retour avant la fin de B + 3 min : pas de retenue ; de retour bien plus tard : retenue', () => {
    const tournee = (est: number) =>
      crs('k2', {
        statut: CourseStatut.IN_DELIVERY,
        deliverer_id: 'd2',
        picked_up_at: h('12:20'),
        parti_at: h('12:20'),
        commandes: [cmd('z', { est, statut: OrderStatus.PICKED_UP })],
      });
    const d2 = livr('d2', T0, { etat: { en_course: true, last_available_at: null } });
    // 1 km : retour vers 12:33:30
    expect(refusDe(base({ autres: [d2], coursesEnPlus: [tournee(1000)] }), 'b', 'k')).toEqual(['AUTRE_LIVREUR_LIBRE']);
    // 5 km : retour bien après 12:36
    expect(actionsDe(base({ autres: [d2], coursesEnPlus: [tournee(5000)] }), 'RETENIR')).toHaveLength(1);
  });

  it('un livreur en pause ne compte pas comme libre, et sa course n’est jamais retenue', () => {
    const d2 = livr('d2', T0, { auComptoir: true, etat: { pause_until: FIN_PAUSE_INDEFINIE } });
    expect(actionsDe(base({ autres: [d2] }), 'RETENIR')).toHaveLength(1);
    expect(actionsDe(base({ d1: { etat: { en_course: true, pause_until: FIN_PAUSE_INDEFINIE } } }), 'RETENIR')).toEqual([]);
  });

  it('course en route : retenue seulement si B sera prête après l’arrivée du livreur', () => {
    const enRoute = (finB: Date) =>
      base({ maintenant: M, statut: CourseStatut.ACCEPTED, finB, d1: { auComptoir: false, aEst: 1000 } }); // arrivée vers 12:34:52
    expect(actionsDe(enRoute(h('12:34')), 'RETENIR')).toEqual([]);
    expect(actionsDe(enRoute(h('12:35')), 'RETENIR')).toEqual([expect.objectContaining({ jusqua: h('12:35') })]);
  });

  it('une commande ne retient qu’une course', () => {
    const k2 = crs('k2', {
      statut: CourseStatut.AT_RESTAURANT,
      deliverer_id: 'd2',
      commandes: [cmd('a2', { est: 2600, created_at: h('12:18') })],
    });
    const d2 = livr('d2', T0, { auComptoir: true, etat: { en_course: true, last_available_at: null } });
    const plan = base({ coursesEnPlus: [k2], autres: [d2] });
    expect(actionsDe(plan, 'RETENIR')).toHaveLength(1);
  });
});

// ─── Retenue au comptoir : trajet long (demande du 24/10) ────────────────────

describe('retenue au comptoir : trajet long (le livreur reviendrait trop tard)', () => {
  /**
   * 15 h 30, hors heure de pointe (22 km/h). D1 au comptoir avec A, prête à
   * 15 h 28, créée à 15 h 20 (promesse 15 h 55, limite 16 h 00). A à 5 km à
   * vol d'oiseau à l'est = 7 km de route = 19 min 05 s : aller-retour de la
   * course (aller, remise 3 min, retour) de 41 min 11 s. B en préparation,
   * même direction, un peu plus loin (5,5 km), créée à 15 h 25.
   */
  const T0 = h('15:30:10');
  const VITESSE_MPS = 22 / 3.6;
  const scene = (o: {
    maintenant?: Date;
    estA?: number;
    creeeA?: Date;
    readyA?: Date;
    estB?: number;
    creeeB?: Date;
    finB?: Date;
    statut?: CourseStatut;
    picked_up_at?: Date | null;
    retenue?: Date | null;
    attendues?: string[];
    enPlus?: ReturnType<typeof cmd>[];
    autres?: ReturnType<typeof livr>[];
    coursesEnPlus?: ReturnType<typeof crs>[];
    reglages?: ReglagesPlanification;
    /** D1 autrement qu'au comptoir (en route, par exemple). */
    d1?: ReturnType<typeof livr>;
  } = {}) => {
    const maintenant = o.maintenant ?? T0;
    const a = cmd('a', { est: o.estA ?? 5000, created_at: o.creeeA ?? h('15:20'), ready_at: o.readyA ?? h('15:28') });
    const k = crs('k', {
      statut: o.statut ?? CourseStatut.AT_RESTAURANT,
      deliverer_id: 'd1',
      picked_up_at: o.picked_up_at ?? null,
      commandes: [a],
      retenue_jusqua: o.retenue ?? null,
      commandes_attendues: o.attendues ?? [],
    });
    const b = enPrep('b', o.finB ?? h('15:40'), { est: o.estB ?? 5500, created_at: o.creeeB ?? h('15:25') });
    const inst = instant(maintenant, {
      commandes: [b, ...(o.enPlus ?? [])],
      courses: [k, ...(o.coursesEnPlus ?? [])],
      livreurs: [
        o.d1 ?? livr('d1', maintenant, { auComptoir: true, etat: { en_course: true, last_available_at: null } }),
        ...(o.autres ?? []),
      ],
    });
    const r = o.reglages ?? REG;
    return { plan: planifier(inst, r), allerRetourMs: allerRetourCourseMs(inst, k, maintenant, r) };
  };

  it('aller-retour de la course : aller, remise au client, retour, à la vitesse du moment', () => {
    // 2 × 7 000 m à 22 km/h + 3 min.
    expect(scene().allerRetourMs / 1000).toBeCloseTo((2 * 7000) / VITESSE_MPS + ARRET_CLIENT_S, 0);
    expect(scene().allerRetourMs / 60_000).toBeCloseTo(41.2, 1);
  });

  it('trajet long : la course attend B toute sa préparation, au-delà de l’horizon et des 5 min', () => {
    // B prête à 15 h 40 : dans 9 min 50 s (horizon 7 min), A aura attendu 12 min (5 min en attente courte).
    // Partir sans B : retour vers 16 h 11, 31 min après que B est prête.
    const { plan, allerRetourMs } = scene();
    expect(types(plan)).toEqual(['RETENIR']);
    expect(actionsDe(plan, 'RETENIR')[0]).toMatchObject({
      course_id: 'k',
      jusqua: h('15:40'),
      motif: 'TRAJET_LONG',
      aller_retour_s: Math.round(allerRetourMs / 1000),
      attendues: [{ order_id: 'b', reference: 'CMD-B', prete_vers: h('15:40'), prete_au_plus_tard: h('15:40'), motif: 'TRAJET_LONG' }],
      libelle: 'Trajet long : attendre CMD-B (prête vers 15 h 40), départ au plus tard 15 h 40',
    });
    // Attente courte seule (trajet long coupé) : B est au-delà de l'horizon, A part.
    expect(actionsDe(scene({ reglages: COURT }).plan, 'RETENIR')).toEqual([]);
    expect(refusDe(scene({ reglages: COURT }).plan, 'b', 'k')).toEqual(['HORIZON']);
  });

  it('trajet long borné par la promesse : jamais une commande de la course après promesse + 5 min', () => {
    // B prête à 15 h 42 : A arriverait à 16 h 01 min 05 s, après sa limite de 16 h 00.
    const plan = scene({ finB: h('15:42') }).plan;
    expect(actionsDe(plan, 'RETENIR')).toEqual([]);
    expect(refusDe(plan, 'b', 'k')).toEqual(['RETARD_CLIENT']);
  });

  it('trajet long borné par l’attente maximale d’une commande prête (course.attente_max_trajet_long_s)', () => {
    // A prête à 15 h 28 : 10 min au plus = 15 h 38, avant B.
    const plan = scene({ reglages: avec({ attenteMaxTrajetLongS: 600 }) }).plan;
    expect(actionsDe(plan, 'RETENIR')).toEqual([]);
    expect(refusDe(plan, 'b', 'k')).toEqual(['LIMITE_RETENUE']);
    expect(plan.refus.find((x) => x.order_id === 'b')!.libelle).toBe('CMD-B prête trop tard, même pour un trajet long');
    // 12 min au plus = 15 h 40 : juste à temps.
    expect(actionsDe(scene({ reglages: avec({ attenteMaxTrajetLongS: 720 }) }).plan, 'RETENIR')).toEqual([
      expect.objectContaining({ jusqua: h('15:40'), motif: 'TRAJET_LONG' }),
    ]);
  });

  it('trajet long : pas de retenue si un autre livreur peut prendre B seule à temps (sauf réglage contraire)', () => {
    const d2 = livr('d2', T0, { auComptoir: true });
    expect(refusDe(scene({ autres: [d2] }).plan, 'b', 'k')).toEqual(['AUTRE_LIVREUR_LIBRE']);
    expect(actionsDe(scene({ autres: [d2], reglages: avec({ retenueMemeSiLivreurLibre: true }) }).plan, 'RETENIR')).toEqual([
      expect.objectContaining({ jusqua: h('15:40'), motif: 'TRAJET_LONG' }),
    ]);
    // Livreur en tournée : de retour avant 15 h 43 (fin de B + 3 min), pas de retenue ; bien plus tard, retenue.
    const tournee = (est: number) =>
      crs('k2', {
        statut: CourseStatut.IN_DELIVERY,
        deliverer_id: 'd2',
        picked_up_at: h('15:20'),
        parti_at: h('15:20'),
        commandes: [cmd('z', { est, statut: OrderStatus.PICKED_UP })],
      });
    const occupe = livr('d2', T0, { etat: { en_course: true, last_available_at: null } });
    expect(refusDe(scene({ autres: [occupe], coursesEnPlus: [tournee(1000)] }).plan, 'b', 'k')).toEqual(['AUTRE_LIVREUR_LIBRE']);
    expect(actionsDe(scene({ autres: [occupe], coursesEnPlus: [tournee(6000)] }).plan, 'RETENIR')).toHaveLength(1);
  });

  it('trajet court (A à 1,5 km de route) : la règle d’avant, inchangée, avec les réglages par défaut', () => {
    // Aller-retour de 11 min 10 s : parti tout de suite, le livreur revient à temps pour B.
    const court = { estA: 1070 };
    expect(scene(court).allerRetourMs / 60_000).toBeCloseTo(11.2, 1);
    for (const finB of ['15:31', '15:32', '15:33', '15:37', '15:38', '15:40', '15:45']) {
      const defaut = scene({ ...court, finB: h(finB) }).plan;
      expect(defaut).toEqual(scene({ ...court, finB: h(finB), reglages: COURT }).plan);
    }
    // 15 h 33 : attente courte, comme avant ; 15 h 40 : au-delà de l'horizon, A part.
    expect(actionsDe(scene({ ...court, finB: h('15:33') }).plan, 'RETENIR')).toEqual([
      expect.objectContaining({
        jusqua: h('15:33'),
        motif: 'ATTENTE_COURTE',
        aller_retour_s: null,
        libelle: 'Attendre CMD-B (prête vers 15 h 33), départ au plus tard 15 h 33',
      }),
    ]);
    expect(refusDe(scene({ ...court, finB: h('15:40') }).plan, 'b', 'k')).toEqual(['HORIZON']);
  });

  it('frontière exacte : aller-retour = préparation restante + petit retard, trajet court ; une seconde de plus, trajet long', () => {
    const court = { estA: 1070 };
    const ar = scene(court).allerRetourMs;
    // Retour à fin de B + 5 min pile : il revient avec un petit retard, la règle d'avant (B après 15 h 33 : refusée).
    const pile = new Date(T0.getTime() + ar - 5 * 60_000);
    const aPile = scene({ ...court, finB: pile }).plan;
    expect(actionsDe(aPile, 'RETENIR')).toEqual([]);
    expect(refusDe(aPile, 'b', 'k')).toEqual(['LIMITE_RETENUE']);
    // B prête une seconde plus tôt : il reviendrait 5 min 01 s après elle, trajet long, la course l'attend.
    const avant = new Date(pile.getTime() - 1000);
    expect(actionsDe(scene({ ...court, finB: avant }).plan, 'RETENIR')).toEqual([
      expect.objectContaining({ jusqua: avant, motif: 'TRAJET_LONG' }),
    ]);
    // Petit retard réglé à 0 : la frontière est l'aller-retour lui-même.
    const zero = avec({ petitRetardRetourMin: 0 });
    const egal = new Date(T0.getTime() + ar);
    expect(actionsDe(scene({ ...court, finB: egal, reglages: zero }).plan, 'RETENIR')).toEqual([]);
    expect(actionsDe(scene({ ...court, finB: new Date(egal.getTime() - 1000), reglages: zero }).plan, 'RETENIR')).toEqual([
      expect.objectContaining({ motif: 'TRAJET_LONG' }),
    ]);
  });

  it('réglages à 0 : attente d’un trajet long 0 = coupé ; petit retard 0 = toute attente plus longue que l’aller-retour', () => {
    expect(scene({ reglages: avec({ attenteMaxTrajetLongS: 0 }) }).plan.actions).toEqual([]);
    // A à 1,5 km (aller-retour 11 min 10 s), B prête dans 8 min : 11 min 10 s ≤ 8 + 5, trajet court, B au-delà de l'horizon.
    const finB = plus(T0, 8 * 60);
    expect(refusDe(scene({ estA: 1070, finB }).plan, 'b', 'k')).toEqual(['HORIZON']);
    // Petit retard 0 : 11 min 10 s > 8 min, trajet long, la course attend B.
    expect(actionsDe(scene({ estA: 1070, finB, reglages: avec({ petitRetardRetourMin: 0 }) }).plan, 'RETENIR')).toEqual([
      expect.objectContaining({ jusqua: finB, motif: 'TRAJET_LONG' }),
    ]);
  });

  it('jamais prolongée quand l’estimation de la cuisine recule : la course part à l’échéance', () => {
    const posee = { retenue: h('15:40'), attendues: ['b'], maintenant: h('15:35') };
    // B annoncée maintenant à 15 h 44 : la retenue garde 15 h 40, rien ne change.
    expect(scene({ ...posee, finB: h('15:44') }).plan.actions).toEqual([]);
    // Une commande arrivée ensuite, prête plus tard, ne l'allonge pas non plus.
    const c = enPrep('c', h('15:45'), { est: 5200, created_at: h('15:26') });
    const avecC = scene({ ...posee, enPlus: [c] }).plan;
    expect(avecC.actions).toEqual([]);
    expect(refusDe(avecC, 'c', 'k')).toEqual(['LIMITE_RETENUE']);
    // À l'échéance, B toujours en cuisine : levée, la course part sans elle.
    expect(scene({ ...posee, finB: h('15:44'), maintenant: h('15:40:05') }).plan.actions).toEqual([
      expect.objectContaining({ type: 'LIBERER', motif: 'ECHEANCE', jusqua: h('15:40') }),
    ]);
    // L'estimation avance : la retenue descend.
    expect(actionsDe(scene({ ...posee, finB: h('15:38') }).plan, 'RETENIR')).toEqual([
      expect.objectContaining({ jusqua: h('15:38'), motif: 'TRAJET_LONG' }),
    ]);
    // L'estimation recule tant que le livreur reviendrait à temps (B prête à 16 h 20) : plus rien à attendre, il part.
    expect(scene({ ...posee, finB: h('16:20') }).plan.actions).toEqual([
      expect.objectContaining({ type: 'LIBERER', motif: 'PLUS_RIEN_A_ATTENDRE' }),
    ]);
  });

  it('après le retrait : la fenêtre d’ajout ne borne plus la retenue, trajet long compris (essai du 25/10)', () => {
    // Retrait à 15 h 30 : la retenue va jusqu'à 15 h 40 ; la fenêtre court ensuite depuis sa fin.
    const plan = scene({ statut: CourseStatut.IN_DELIVERY, picked_up_at: h('15:30') }).plan;
    expect(actionsDe(plan, 'RETENIR')).toEqual([expect.objectContaining({ jusqua: h('15:40'), motif: 'TRAJET_LONG' })]);
  });

  it('heure de pointe : la vitesse de pointe allonge l’aller-retour (même trajet, court à 15 h 30, long à 12 h 30)', () => {
    // A à 1,5 km de route, B à 2,8 km (même direction), prête dans 8 min.
    const a15 = { estA: 1070, estB: 2000, finB: plus(T0, 8 * 60) };
    const T12 = h('12:30:10');
    const a12 = {
      ...a15,
      maintenant: T12,
      creeeA: h('12:20'),
      readyA: h('12:28'),
      creeeB: h('12:25'),
      finB: plus(T12, 8 * 60),
    };
    // 22 km/h : 11 min 10 s ; 16 km/h : 14 min 14 s.
    expect(scene(a15).allerRetourMs / 1000).toBeCloseTo((2 * 1498) / VITESSE_MPS + ARRET_CLIENT_S, -1);
    expect(scene(a12).allerRetourMs / 1000).toBeCloseTo((2 * 1498) / (16 / 3.6) + ARRET_CLIENT_S, -1);
    expect(refusDe(scene(a15).plan, 'b', 'k')).toEqual(['HORIZON']);
    expect(actionsDe(scene(a12).plan, 'RETENIR')).toEqual([expect.objectContaining({ jusqua: a12.finB, motif: 'TRAJET_LONG' })]);
  });

  it('jamais de mélange route / vol d’oiseau dans l’aller-retour', () => {
    const route = (id: string, est: number, routeMetres: number | null) => {
      const c = cmd(id, { est });
      return { ...c, client: { ...c.client, routeMetres } };
    };
    const course = (commandes: ReturnType<typeof cmd>[]) => crs('k', { statut: CourseStatut.AT_RESTAURANT, deliverer_id: 'd1', commandes });
    const mesure = (commandes: ReturnType<typeof cmd>[]) => allerRetourCourseMs(instant(T0, { courses: [course(commandes)] }), course(commandes), T0);
    // Distance routière connue (9 km) : aller et retour par la route.
    expect(mesure([route('a', 5000, 9000)]) / 1000).toBeCloseTo((2 * 9000) / VITESSE_MPS + ARRET_CLIENT_S, 0);
    // Tournée au vol d'oiseau (l'autre client n'a pas de distance routière) : le retour aussi, jamais les 9 km de route.
    const volOiseau = ((4000 + 1000) * 1.4 + 5000 * 1.4) / VITESSE_MPS + 2 * ARRET_CLIENT_S;
    expect(mesure([route('c', 4000, null), route('a', 5000, 9000)]) / 1000).toBeCloseTo(volOiseau, 0);
  });

  // ── Relecture adverse du 24/10 ──

  /** D2 en tournée depuis 15 h 20 chez un client à 3 km : de retour vers 15 h 45 min 54 s. */
  const d2EnTournee = (maintenant: Date) => ({
    autres: [livr('d2', maintenant, { etat: { en_course: true, last_available_at: null } })],
    coursesEnPlus: [
      crs('k2', {
        statut: CourseStatut.IN_DELIVERY,
        deliverer_id: 'd2',
        picked_up_at: h('15:20'),
        parti_at: h('15:20'),
        commandes: [cmd('z', { est: 3000, statut: OrderStatus.PICKED_UP })],
      }),
    ],
  });

  it('estimation qui recule : un autre livreur prendra B seule à sa nouvelle heure, la course n’attend pas pour rien', () => {
    const posee = { retenue: h('15:40'), attendues: ['b'], maintenant: h('15:35'), ...d2EnTournee(h('15:35')) };
    // B annoncée pour 15 h 46 : D2, de retour vers 15 h 45 min 54 s, la prendra
    // seule. Garder A jusqu'à 15 h 40 ne servirait à rien : levée, A part.
    const plan = scene({ ...posee, finB: h('15:46') }).plan;
    expect(plan.actions).toEqual([expect.objectContaining({ type: 'LIBERER', motif: 'PLUS_RIEN_A_ATTENDRE' })]);
    expect(refusDe(plan, 'b', 'k')).toEqual(['AUTRE_LIVREUR_LIBRE']);
    // B annoncée pour 15 h 42 : D2 revient après 15 h 45, la retenue garde son échéance.
    expect(scene({ ...posee, finB: h('15:42') }).plan.actions).toEqual([]);
  });

  it('livreur retenu ailleurs : son retour compte depuis l’échéance de sa retenue, pas depuis maintenant', () => {
    // D3 au comptoir avec A1 (1 km au nord), retenu jusqu'à 15 h 33 pour Q1 :
    // de retour vers 15 h 43 min 38 s (15 h 40 min 48 s s'il partait maintenant).
    // D1 au comptoir avec A (7 km de route à l'est), B prête à 15 h 40 : trajet long.
    const monde = (retenueD3: boolean) => {
      const a = cmd('a', { est: 5000, created_at: h('15:20'), ready_at: h('15:28') });
      const a1 = cmd('a1', { nord: 1000, est: 0, created_at: h('15:20'), ready_at: h('15:28') });
      const q1 = enPrep('q1', h('15:33'), { nord: 1200, est: 0, created_at: h('15:22') });
      const b = enPrep('b', h('15:40'), { est: 5500, created_at: h('15:25') });
      const enCourse = { auComptoir: true, etat: { en_course: true, last_available_at: null } };
      return planifier(
        instant(T0, {
          commandes: retenueD3 ? [b, q1] : [b],
          courses: [
            crs('k', { statut: CourseStatut.AT_RESTAURANT, deliverer_id: 'd1', commandes: [a] }),
            crs('k1', {
              statut: CourseStatut.AT_RESTAURANT,
              deliverer_id: 'd3',
              commandes: [a1],
              retenue_jusqua: retenueD3 ? h('15:33') : null,
              commandes_attendues: retenueD3 ? ['q1'] : [],
            }),
          ],
          livreurs: [livr('d1', T0, enCourse), livr('d3', T0, enCourse)],
        }),
      );
    };
    // D3 retenu : il ne sera pas là avant 15 h 43 (fin de B + 3 min), la course de D1 attend B.
    expect(actionsDe(monde(true), 'RETENIR')).toEqual([
      expect.objectContaining({ course_id: 'k', jusqua: h('15:40'), motif: 'TRAJET_LONG' }),
    ]);
    // D3 libre de partir : il revient à temps pour B, la course de D1 ne l'attend pas.
    expect(actionsDe(monde(false), 'RETENIR')).toEqual([]);
    expect(refusDe(monde(false), 'b', 'k')).toEqual(['AUTRE_LIVREUR_LIBRE']);
  });

  it('deuxième commande attendue : le retour se compte depuis le départ avec la première', () => {
    // A à 1,5 km de route ; C (1,2 km) prête à 15 h 33, attente courte. Partie
    // à 15 h 33 avec A et C, D1 reviendrait vers 15 h 48 min 10 s.
    const c = (finB: Date) =>
      scene({ estA: 1070, estB: 2000, finB, enPlus: [enPrep('c', h('15:33'), { est: 1200, created_at: h('15:24') })] }).plan;
    // B prête à 15 h 41 min 30 s : il reviendrait 6 min 40 s après elle, trajet long, A et C l'attendent.
    expect(actionsDe(c(h('15:41:30')), 'RETENIR')).toEqual([
      expect.objectContaining({
        jusqua: h('15:41:30'),
        motif: 'TRAJET_LONG',
        attendues: [
          expect.objectContaining({ order_id: 'c', motif: 'ATTENTE_COURTE' }),
          expect.objectContaining({ order_id: 'b', motif: 'TRAJET_LONG' }),
        ],
      }),
    ]);
    // B prête à 15 h 43 min 30 s : il reviendrait moins de 5 min après elle, trajet court, B au-delà de l'horizon.
    const court = c(h('15:43:30'));
    expect(actionsDe(court, 'RETENIR')).toEqual([
      expect.objectContaining({ jusqua: h('15:33'), motif: 'ATTENTE_COURTE', attendues: [expect.objectContaining({ order_id: 'c' })] }),
    ]);
    expect(refusDe(court, 'b', 'k')).toEqual(['HORIZON']);
  });

  it('livreur en route : le retour se compte depuis son arrivée au restaurant', () => {
    // D1 sans position : arrivée supposée dans 8 min (15 h 38 min 10 s). A à
    // 1,5 km de route (aller-retour 11 min 10 s) : retour vers 15 h 49 min 20 s.
    const enRoute = livr('d1', T0, { etat: { en_course: true, last_available_at: null } });
    const plan = scene({ estA: 1070, finB: plus(T0, 10 * 60), statut: CourseStatut.ACCEPTED, d1: enRoute }).plan;
    // B prête à 15 h 40 min 10 s : il reviendrait 9 min après elle, trajet long, il l'attend 2 min au comptoir.
    expect(actionsDe(plan, 'RETENIR')).toEqual([expect.objectContaining({ jusqua: plus(T0, 10 * 60), motif: 'TRAJET_LONG' })]);
    // Au comptoir, le même trajet est court : il part, B est au-delà de l'horizon.
    expect(refusDe(scene({ estA: 1070, finB: plus(T0, 10 * 60) }).plan, 'b', 'k')).toEqual(['HORIZON']);
  });

  it('horizon réglé sous l’attente courte : trajet court, refus horizon ; trajet long, retenue « trajet long »', () => {
    const r = avec({ horizonPreparationS: 120 });
    // B prête à 15 h 33, dans 2 min 50 s, au-delà de l'horizon de 2 min.
    // A à 700 m de route (aller-retour 6 min 49 s, au plus 7 min 50 s) : trajet court, A part.
    const court = scene({ estA: 500, finB: h('15:33'), reglages: r }).plan;
    expect(actionsDe(court, 'RETENIR')).toEqual([]);
    expect(refusDe(court, 'b', 'k')).toEqual(['HORIZON']);
    // A à 7 km de route : trajet long, la course attend B.
    expect(actionsDe(scene({ finB: h('15:33'), reglages: r }).plan, 'RETENIR')).toEqual([
      expect.objectContaining({ jusqua: h('15:33'), motif: 'TRAJET_LONG' }),
    ]);
  });

  it('estimation qui recule après le retrait : la retenue garde son échéance, la remise ne la rabote plus (essai du 25/10)', () => {
    // Retenue jusqu'à 15 h 33 pour B ; retrait validé à 15 h 30 ; B annoncée
    // maintenant pour 15 h 36 : la retenue n'est jamais prolongée, ni réduite
    // par la remise (la fenêtre court depuis 15 h 33).
    const plan = scene({
      statut: CourseStatut.IN_DELIVERY,
      picked_up_at: h('15:30'),
      maintenant: h('15:31:30'),
      retenue: h('15:33'),
      attendues: ['b'],
      finB: h('15:36'),
    }).plan;
    expect(plan.actions).toEqual([]);
  });
});

// ─── Ajout après le retrait, départ, détachement ─────────────────────────────

describe('ajout après le retrait (3.8) et départ', () => {
  const recuperee = (commandes = [cmd('o', { est: 2000, statut: OrderStatus.PICKED_UP })]) =>
    crs('k', { statut: CourseStatut.IN_DELIVERY, deliverer_id: 'd1', picked_up_at: h('12:30'), commandes });
  const d1 = (maintenant: Date, o: Parameters<typeof livr>[2] = {}) =>
    livr('d1', maintenant, { auComptoir: true, etat: { en_course: true, last_available_at: null }, ...o });

  it('livreur encore au comptoir (nouvelle appli) : la commande prête lui est ajoutée, même code', () => {
    const now = h('12:32');
    const plan = planifier(instant(now, { commandes: [cmd('q', { est: 2300, ready_at: now })], courses: [recuperee()], livreurs: [d1(now)] }));
    expect(types(plan)).toEqual(['AJOUTER', 'ORDONNER']);
    expect(actionsDe(plan, 'AJOUTER')[0]).toMatchObject({ course_id: 'k', apres_retrait: true, statut_course: CourseStatut.IN_DELIVERY });
  });

  it('ancienne appli : jamais d’ajout après le retrait, la course est réputée partie', () => {
    const now = h('12:32');
    const plan = planifier(
      instant(now, { commandes: [cmd('q', { est: 2300, ready_at: now })], courses: [recuperee()], livreurs: [d1(now, { protocole_appli: 2 })] }),
    );
    expect(actionsDe(plan, 'MARQUER_PARTI')).toEqual([expect.objectContaining({ course_id: 'k', motif: 'ANCIENNE_APPLI' })]);
    expect(actionsDe(plan, 'AJOUTER')).toEqual([]);
    expect(actionsDe(plan, 'CREER_COURSE')[0].order_ids).toEqual(['q']);
  });

  it('après la fenêtre, après une position à 300 m ou une livraison commencée : parti', () => {
    const q = (now: Date) => cmd('q', { est: 2300, ready_at: now });
    const fenetre = planifier(instant(h('12:34'), { commandes: [q(h('12:34'))], courses: [recuperee()], livreurs: [d1(h('12:34'))] }));
    expect(actionsDe(fenetre, 'MARQUER_PARTI')[0].motif).toBe('FENETRE_ECHUE');
    expect(actionsDe(fenetre, 'AJOUTER')).toEqual([]);

    const now = h('12:32');
    const sorti = planifier(
      instant(now, {
        commandes: [q(now)],
        courses: [recuperee()],
        livreurs: [d1(now, { auComptoir: false, position: decale(R, 0, 300), position_at: h('12:31:40') })],
      }),
    );
    expect(actionsDe(sorti, 'MARQUER_PARTI')[0].motif).toBe('POSITION');

    const commencee = crs('k', {
      statut: CourseStatut.IN_DELIVERY,
      deliverer_id: 'd1',
      picked_up_at: h('12:30'),
      livraisons: [{ id: 'l', statut: DeliveryStatut.IN_ROUTE, sequence_order: 1, commande: cmd('o', { statut: OrderStatus.PICKED_UP }) }],
    });
    const route = planifier(instant(now, { commandes: [q(now)], courses: [commencee], livreurs: [d1(now)] }));
    expect(actionsDe(route, 'MARQUER_PARTI')[0].motif).toBe('LIVRAISON_DEMARREE');
  });

  it('départ : la commande ajoutée pas encore remise est détachée et repart aussitôt', () => {
    const avecAjoutNonRemis = () =>
      crs('k', {
        statut: CourseStatut.IN_DELIVERY,
        deliverer_id: 'd1',
        picked_up_at: h('12:30'),
        livraisons: [
          { id: 'l1', statut: DeliveryStatut.PENDING, sequence_order: 1, commande: cmd('o', { statut: OrderStatus.PICKED_UP }) },
          {
            id: 'l2',
            statut: DeliveryStatut.PENDING,
            sequence_order: 2,
            ajoutee_apres_retrait: true,
            commande: cmd('x', { est: 2300, ready_at: h('12:33') }),
          },
        ],
      });
    // Fenêtre échue, aucune position connue (on ne sait pas qu'il est au comptoir) : parti.
    const now = h('12:34:10');
    const plan = planifier(
      instant(now, {
        courses: [avecAjoutNonRemis()],
        livreurs: [d1(now, { position: null, position_at: null }), livr('d2', now, { auComptoir: true })],
      }),
    );
    expect(types(plan)).toEqual(['MARQUER_PARTI', 'DETACHER', 'CREER_COURSE', 'OFFRIR']);
    expect(actionsDe(plan, 'DETACHER')[0]).toMatchObject({ course_id: 'k', order_id: 'x', motif: 'LIVREUR_PARTI' });
    expect(actionsDe(plan, 'CREER_COURSE')[0].order_ids).toEqual(['x']);
    expect(actionsDe(plan, 'OFFRIR')[0].deliverer_id).toBe('d2');

    // Livreur encore au comptoir (position de 30 s) : il attend son sac, au plus 2 min de plus.
    const attend = planifier(instant(now, { courses: [avecAjoutNonRemis()], livreurs: [d1(now), livr('d2', now, { auComptoir: true })] }));
    expect(types(attend)).toEqual([]);
    // Immobile au comptoir depuis son arrivée (dernière position avant le retrait, l'appli
    // n'envoie rien à l'arrêt) : il attend aussi son sac (seconde relecture).
    const immobile = planifier(
      instant(now, { courses: [avecAjoutNonRemis()], livreurs: [d1(now, { position_at: h('12:29:30') }), livr('d2', now, { auComptoir: true })] }),
    );
    expect(types(immobile)).toEqual([]);
    // Plus rien depuis 12:19 (téléphone sans la permission « Toujours », appli en arrière-plan),
    // dernière position au comptoir : il attend aussi son sac (seconde passe).
    const muet = planifier(
      instant(now, { courses: [avecAjoutNonRemis()], livreurs: [d1(now, { position_at: h('12:19') }), livr('d2', now, { auComptoir: true })] }),
    );
    expect(types(muet)).toEqual([]);
    const tard = h('12:36:01');
    const apres = planifier(instant(tard, { courses: [avecAjoutNonRemis()], livreurs: [d1(tard), livr('d2', tard, { auComptoir: true })] }));
    expect(types(apres)).toEqual(['MARQUER_PARTI', 'DETACHER', 'CREER_COURSE', 'OFFRIR']);
    expect(actionsDe(apres, 'MARQUER_PARTI')[0].motif).toBe('FENETRE_ECHUE');
  });

  it('fin de fenêtre : plus d’ajout à moins de 90 s, le sac a le temps d’être remis (relecture) ; la retenue n’y est plus bornée', () => {
    // Retrait à 12:30, fenêtre jusqu'à 12:34. À 12:32:35 (85 s avant) : la commande prête part seule.
    const tard = h('12:32:35');
    const plan = planifier(
      instant(tard, { commandes: [cmd('q', { est: 2300, ready_at: tard })], courses: [recuperee()], livreurs: [d1(tard)] }),
    );
    expect(actionsDe(plan, 'AJOUTER')).toEqual([]);
    expect(refusDe(plan, 'q', 'k')).toEqual(['FIN_DE_FENETRE']);
    expect(actionsDe(plan, 'CREER_COURSE')[0].order_ids).toEqual(['q']);
    // À 12:32:25 (95 s avant) : encore ajoutée.
    const avant = h('12:32:25');
    const ok = planifier(instant(avant, { commandes: [cmd('q', { est: 2300, ready_at: avant })], courses: [recuperee()], livreurs: [d1(avant)] }));
    expect(actionsDe(ok, 'AJOUTER')[0]).toMatchObject({ course_id: 'k', apres_retrait: true });

    // Retenue : plus bornée par la fin de la fenêtre moins 90 s (essai du
    // 25/10) ; la fenêtre court depuis la fin de la retenue.
    const t0 = h('12:31');
    const retenue = planifier(
      instant(t0, { commandes: [enPrep('b', h('12:32:20'), { est: 2300 })], courses: [recuperee()], livreurs: [d1(t0)] }),
    );
    expect(actionsDe(retenue, 'RETENIR')[0]).toMatchObject({ course_id: 'k', jusqua: h('12:32:20') });
    const auDela = planifier(
      instant(t0, { commandes: [enPrep('b', h('12:32:40'), { est: 2300 })], courses: [recuperee()], livreurs: [d1(t0)] }),
    );
    expect(actionsDe(auDela, 'RETENIR')[0]).toMatchObject({ course_id: 'k', jusqua: h('12:32:40') });
  });

  it('fenêtre réglée sous 3 min : la marge de remise est la moitié de la fenêtre, les ajouts restent possibles (banc du 23/10)', () => {
    const courte = avec({ ajoutApresRetraitMaxS: 60 });
    // Retrait à 12:30, fenêtre de 60 s jusqu'à 12:31, marge 30 s : ajout possible jusqu'à 12:30:30.
    const tot = h('12:30:20');
    const ok = planifier(
      instant(tot, { commandes: [cmd('q', { est: 2300, ready_at: tot })], courses: [recuperee()], livreurs: [d1(tot)] }),
      courte,
    );
    expect(actionsDe(ok, 'AJOUTER')[0]).toMatchObject({ course_id: 'k', apres_retrait: true });
    const tard = h('12:30:35');
    const non = planifier(
      instant(tard, { commandes: [cmd('q', { est: 2300, ready_at: tard })], courses: [recuperee()], livreurs: [d1(tard)] }),
      courte,
    );
    expect(refusDe(non, 'q', 'k')).toEqual(['FIN_DE_FENETRE']);
    expect(actionsDe(non, 'CREER_COURSE')[0].order_ids).toEqual(['q']);
    // Retenue : plus bornée par la fin de la fenêtre moins 30 s (essai du 25/10).
    const t0 = h('12:30:05');
    const retenue = planifier(
      instant(t0, { commandes: [enPrep('b', h('12:30:25'), { est: 2300 })], courses: [recuperee()], livreurs: [d1(t0)] }),
      courte,
    );
    expect(actionsDe(retenue, 'RETENIR')[0]).toMatchObject({ course_id: 'k', jusqua: h('12:30:25') });
    const auDela = planifier(
      instant(t0, { commandes: [enPrep('b', h('12:30:40'), { est: 2300 })], courses: [recuperee()], livreurs: [d1(t0)] }),
      courte,
    );
    expect(actionsDe(auDela, 'RETENIR')[0]).toMatchObject({ course_id: 'k', jusqua: h('12:30:40') });
    // Fenêtre par défaut (240 s) : marge inchangée de 90 s.
    expect(margeRemiseApresRetraitMs(REG)).toBe(90_000);
    expect(margeRemiseApresRetraitMs(avec({ ajoutApresRetraitMaxS: 0 }))).toBe(0);
  });

  it('départ : une commande de la course d’origine pas encore remise (bouton de la caisse) reste dans la course', () => {
    const k = crs('k', {
      statut: CourseStatut.IN_DELIVERY,
      deliverer_id: 'd1',
      picked_up_at: h('12:30'),
      livraisons: [
        { id: 'l1', statut: DeliveryStatut.PENDING, sequence_order: 1, commande: cmd('o', { statut: OrderStatus.PICKED_UP }) },
        { id: 'l2', statut: DeliveryStatut.PENDING, sequence_order: 2, commande: cmd('y', { ready_at: h('12:20') }) },
      ],
    });
    // Livreur au comptoir : il attend ce sac, au plus 2 min après la fenêtre (seconde passe).
    const attend = h('12:34:10');
    expect(types(planifier(instant(attend, { courses: [k], livreurs: [d1(attend)] })))).toEqual([]);
    const now = h('12:36:01');
    const plan = planifier(instant(now, { courses: [k], livreurs: [d1(now)] }));
    expect(types(plan)).toEqual(['MARQUER_PARTI']);
  });

  it('course déjà partie : ni ajout ni nouvelle action', () => {
    const now = h('12:32');
    const partie = { ...recuperee(), parti_at: h('12:31') };
    const plan = planifier(instant(now, { commandes: [cmd('q', { est: 2300, ready_at: now })], courses: [partie], livreurs: [d1(now)] }));
    expect(types(plan)).toEqual(['CREER_COURSE']);
  });

  it('course partie par « Je pars » avec une commande ajoutée pas remise : détachée et reprise dans le même passage', () => {
    const now = h('12:33');
    const k = crs('k', {
      statut: CourseStatut.IN_DELIVERY,
      deliverer_id: 'd1',
      picked_up_at: h('12:30'),
      parti_at: h('12:32'),
      livraisons: [
        { id: 'l1', statut: DeliveryStatut.PENDING, sequence_order: 1, commande: cmd('o', { statut: OrderStatus.PICKED_UP }) },
        { id: 'l2', statut: DeliveryStatut.PENDING, sequence_order: 2, ajoutee_apres_retrait: true, commande: cmd('c', { ready_at: h('12:31') }) },
      ],
    });
    const plan = planifier(instant(now, { courses: [k], livreurs: [d1(now)] }));
    expect(types(plan)).toEqual(['DETACHER', 'CREER_COURSE']);
    expect(actionsDe(plan, 'DETACHER')[0]).toMatchObject({ course_id: 'k', order_id: 'c', motif: 'LIVREUR_PARTI' });
    expect(actionsDe(plan, 'CREER_COURSE')[0].order_ids).toEqual(['c']);
  });
});

// ─── Offres ──────────────────────────────────────────────────────────────────

describe('offres : par urgence, au meilleur livreur libre, jamais à qui ne peut la recevoir', () => {
  it('la course la plus urgente d’abord quand un seul livreur est libre', () => {
    const urgente = crs('k1', { commandes: [cmd('a', { est: 2000, created_at: h('12:00'), ready_at: h('12:20') })] });
    const recente = crs('k2', { commandes: [cmd('b', { est: -2000, created_at: h('12:20'), ready_at: h('12:28') })] });
    const plan = planifier(instant(M, { courses: [recente, urgente], livreurs: [livr('d1', M, { auComptoir: true })] }));
    expect(actionsDe(plan, 'FUSIONNER')).toEqual([]);
    expect(actionsDe(plan, 'OFFRIR')).toEqual([expect.objectContaining({ course_id: 'k1', deliverer_id: 'd1' })]);
    expect(actionsDe(plan, 'OFFRIR')[0].marge_s).toBeLessThan(0);
  });

  it('jamais à un livreur en pause, en pause automatique, hors service, avec une offre, déjà sollicité', () => {
    const k = crs('k', { commandes: [cmd('a')], deja_sollicites: ['d-refus'] });
    const exclus = [
      livr('d-pause', M, { auComptoir: true, etat: { pause_until: FIN_PAUSE_INDEFINIE } }),
      livr('d-auto', M, { auComptoir: true, etat: { auto_pause_until: plus(M, 60) } }),
      livr('d-hs', M, { auComptoir: true, etat: { last_available_at: null } }),
      livr('d-offre', M, { auComptoir: true, etat: { offre_en_attente: true } }),
      livr('d-course', M, { auComptoir: true, etat: { en_course: true } }),
      livr('d-refus', M, { auComptoir: true }),
    ];
    expect(actionsDe(planifier(instant(M, { courses: [k], livreurs: exclus })), 'OFFRIR')).toEqual([]);
    const plan = planifier(instant(M, { courses: [k], livreurs: [...exclus, livr('d-ok', M, { aEst: 3000 })] }));
    expect(actionsDe(plan, 'OFFRIR')).toEqual([expect.objectContaining({ deliverer_id: 'd-ok' })]);
  });

  it('une course avec une offre en attente n’est pas reproposée', () => {
    const k = crs('k', { commandes: [cmd('a')], offre: { id: 'o', deliverer_id: 'd9', expires_at: h('12:31') } });
    expect(planifier(instant(M, { courses: [k], livreurs: [livr('d1', M, { auComptoir: true })] })).actions).toEqual([]);
  });

  it('un livreur, une offre : deux courses, deux livreurs libres', () => {
    const k1 = crs('k1', { commandes: [cmd('a', { est: 2000, created_at: h('12:05') })] });
    const k2 = crs('k2', { commandes: [cmd('b', { est: -2000, created_at: h('12:10') })] });
    const plan = planifier(
      instant(M, {
        courses: [k1, k2],
        livreurs: [livr('d1', M, { auComptoir: true, etat: { last_available_at: h('12:00') } }), livr('d2', M, { aEst: 1000 })],
      }),
    );
    expect(actionsDe(plan, 'OFFRIR').map((a) => [a.course_id, a.deliverer_id])).toEqual([
      ['k1', 'd1'],
      ['k2', 'd2'],
    ]);
  });
});

// ─── Fusions (demande 4) ─────────────────────────────────────────────────────

describe('fusion des courses créées mais pas encore affectées (demande 4)', () => {
  const k1 = () => crs('k1', { created_at: h('12:28'), commandes: [cmd('a', { est: 2000, ready_at: h('12:28') })] });
  const k2 = () => crs('k2', { created_at: h('12:29'), commandes: [cmd('b', { est: 2400, ready_at: h('12:29') })] });

  it('même direction, sans livreur libre : fusionnées dans la plus ancienne, ordre recalculé', () => {
    const plan = planifier(instant(M, { courses: [k2(), k1()] }));
    expect(types(plan)).toEqual(['FUSIONNER', 'ORDONNER']);
    expect(actionsDe(plan, 'FUSIONNER')[0]).toMatchObject({ cible_id: 'k1', absorbee_id: 'k2', order_ids: ['b'], offres_a_clore: [] });
    expect(actionsDe(plan, 'ORDONNER')[0]).toMatchObject({ course_id: 'k1', sequence: ['a', 'b'] });
  });

  it('avec un livreur libre au comptoir : fusionnées puis proposées aussitôt', () => {
    const plan = planifier(instant(M, { courses: [k1(), k2()], livreurs: [livr('d1', M, { auComptoir: true })] }));
    expect(types(plan)).toEqual(['FUSIONNER', 'ORDONNER', 'OFFRIR']);
    expect(actionsDe(plan, 'OFFRIR')[0]).toMatchObject({ course_id: 'k1', deliverer_id: 'd1' });
  });

  it('offre en attente sur la course absorbée : close sans pénalité, la fusion part au livreur du comptoir', () => {
    const offre = { id: 'offre-d2', deliverer_id: 'd2', expires_at: h('12:31') };
    const plan = planifier(
      instant(M, {
        courses: [k1(), { ...k2(), offre }],
        livreurs: [livr('d1', M, { auComptoir: true }), livr('d2', M, { aEst: 3000, etat: { offre_en_attente: true } })],
      }),
    );
    expect(actionsDe(plan, 'FUSIONNER')[0]).toMatchObject({ cible_id: 'k1', absorbee_id: 'k2', offres_a_clore: [offre] });
    expect(actionsDe(plan, 'OFFRIR')).toEqual([expect.objectContaining({ course_id: 'k1', deliverer_id: 'd1' })]);
  });

  it('offre en attente sur la cible : gardée (réémise à jour), pas de nouvelle offre', () => {
    const offre = { id: 'offre-d1', deliverer_id: 'd1', expires_at: h('12:31') };
    const plan = planifier(
      instant(M, {
        courses: [{ ...k1(), offre }, k2()],
        livreurs: [livr('d1', M, { auComptoir: true, etat: { offre_en_attente: true } })],
      }),
    );
    expect(actionsDe(plan, 'FUSIONNER')[0]).toMatchObject({ cible_id: 'k1', offre_cible: offre, offres_a_clore: [] });
    expect(actionsDe(plan, 'OFFRIR')).toEqual([]);
  });

  it('la course qui garde l’offre devient la cible même si elle est plus récente', () => {
    const offre = { id: 'offre-d1', deliverer_id: 'd1', expires_at: h('12:31') };
    const plan = planifier(
      instant(M, {
        courses: [k1(), { ...k2(), offre }],
        livreurs: [livr('d1', M, { auComptoir: true, etat: { offre_en_attente: true } })],
      }),
    );
    expect(actionsDe(plan, 'FUSIONNER')[0]).toMatchObject({ cible_id: 'k2', absorbee_id: 'k1', offre_cible: offre, offres_a_clore: [] });
  });

  it('sens opposés : jamais fusionnées', () => {
    const ouest = crs('k2', { commandes: [cmd('b', { est: -2000, ready_at: h('12:29') })] });
    const plan = planifier(instant(M, { courses: [k1(), ouest] }));
    expect(actionsDe(plan, 'FUSIONNER')).toEqual([]);
    expect(refusDe(plan, 'k2', 'k1')).toContain('DIRECTION');
  });

  it('une course sans livreur rejoint la course d’un livreur au comptoir', () => {
    const auComptoir = crs('k0', { statut: CourseStatut.AT_RESTAURANT, deliverer_id: 'd1', commandes: [cmd('o', { est: 2200 })] });
    const plan = planifier(
      instant(M, { courses: [auComptoir, k2()], livreurs: [livr('d1', M, { auComptoir: true, etat: { en_course: true } })] }),
    );
    expect(actionsDe(plan, 'FUSIONNER')[0]).toMatchObject({ cible_id: 'k0', absorbee_id: 'k2', apres_retrait: false });
  });

  it('jamais avec une course confiée à Turbo ni vers la course d’un livreur en pause', () => {
    const turbo = { ...k2(), turbo_escalated_at: h('12:29:30') };
    const enPause = crs('k0', { statut: CourseStatut.AT_RESTAURANT, deliverer_id: 'd1', commandes: [cmd('o', { est: 2200 })] });
    const plan = planifier(
      instant(M, {
        courses: [k1(), turbo, enPause],
        livreurs: [livr('d1', M, { auComptoir: true, etat: { en_course: true, pause_until: FIN_PAUSE_INDEFINIE } })],
      }),
    );
    expect(actionsDe(plan, 'FUSIONNER')).toEqual([]);
  });

  it('taille : deux courses de deux commandes ne font pas une course de quatre', () => {
    const deux1 = crs('k1', { commandes: [cmd('a', { est: 2000, ready_at: h('12:28') }), cmd('a2', { est: 2100, ready_at: h('12:28') })] });
    const deux2 = crs('k2', { commandes: [cmd('b', { est: 2300, ready_at: h('12:29') }), cmd('b2', { est: 2400, ready_at: h('12:29') })] });
    const plan = planifier(instant(M, { courses: [deux1, deux2] }));
    expect(actionsDe(plan, 'FUSIONNER')).toEqual([]);
    expect(refusDe(plan, 'k2', 'k1')).toContain('TAILLE');
  });

  it('jamais une course qui a déjà son livreur comme course absorbée', () => {
    const acceptee = crs('k2', { statut: CourseStatut.ACCEPTED, deliverer_id: 'd2', commandes: [cmd('b', { est: 2400 })] });
    const auComptoir = crs('k1', { statut: CourseStatut.AT_RESTAURANT, deliverer_id: 'd1', commandes: [cmd('a', { est: 2000 })] });
    const plan = planifier(
      instant(M, {
        courses: [auComptoir, acceptee],
        livreurs: [
          livr('d1', M, { auComptoir: true, etat: { en_course: true } }),
          livr('d2', M, { aEst: 1000, etat: { en_course: true } }),
        ],
      }),
    );
    expect(actionsDe(plan, 'FUSIONNER')).toEqual([]);
  });
});

// ─── Turbo dans le passage ───────────────────────────────────────────────────

describe('Turbo dans le passage : dernier recours', () => {
  const ancienne = () => crs('k', { created_at: h('12:28'), commandes: [cmd('a', { ready_at: h('12:24') })] });

  it('aucun livreur depuis 6 min (depuis la commande prête) : confiée à Turbo', () => {
    const plan = planifier(instant(M, { courses: [ancienne()] }));
    expect(actionsDe(plan, 'CONFIER_TURBO')).toEqual([expect.objectContaining({ course_id: 'k', minutes: 6 })]);
  });

  it('un livreur libre : offerte, pas confiée à Turbo', () => {
    const plan = planifier(instant(M, { courses: [ancienne()], livreurs: [livr('d1', M, { aEst: 4000 })] }));
    expect(types(plan)).toEqual(['OFFRIR']);
  });

  it('une course créée dans ce passage n’est jamais confiée à Turbo dans le même passage', () => {
    const plan = planifier(instant(M, { commandes: [cmd('a', { ready_at: h('12:20') })] }));
    expect(types(plan)).toEqual(['CREER_COURSE']);
  });
});

// ─── Repli v1 et paires à mesurer ────────────────────────────────────────────

describe('retour à v1 en pleine activité (5.5)', () => {
  it('courses récupérées encore au restaurant parties, ajouts non remis détachés, retenues levées', () => {
    const now = h('12:32');
    const k = crs('k', {
      statut: CourseStatut.IN_DELIVERY,
      deliverer_id: 'd1',
      picked_up_at: h('12:30'),
      livraisons: [
        { id: 'l1', statut: DeliveryStatut.PENDING, sequence_order: 1, commande: cmd('o', { statut: OrderStatus.PICKED_UP }) },
        { id: 'l2', statut: DeliveryStatut.PENDING, sequence_order: 2, ajoutee_apres_retrait: true, commande: cmd('x') },
        // Commande de la course d'origine pas encore remise (bouton de la caisse) : gardée.
        { id: 'l3', statut: DeliveryStatut.PENDING, sequence_order: 3, commande: cmd('y') },
      ],
    });
    const retenue = crs('k2', { statut: CourseStatut.AT_RESTAURANT, deliverer_id: 'd2', commandes: [cmd('a')], retenue_jusqua: h('12:34'), commandes_attendues: ['b'] });
    const levee = crs('k3', { statut: CourseStatut.AT_RESTAURANT, deliverer_id: 'd3', commandes: [cmd('c')], retenue_jusqua: h('12:31') });
    const actions = actionsRepliV1(instant(now, { courses: [k, retenue, levee] }));
    expect(actions.map((a) => a.type)).toEqual(['MARQUER_PARTI', 'DETACHER', 'LIBERER']);
    expect(actions[1]).toMatchObject({ order_id: 'x', motif: 'REPLI_V1' });
    expect(actions[2]).toMatchObject({ course_id: 'k2', motif: 'REPLI_V1', jusqua: now });
  });
});

describe('paires dont le service mesure la direction', () => {
  it('mobiles entre elles et face aux courses ouvertes, jamais entre deux courses affectées', () => {
    const inst = instant(M, {
      commandes: [
        cmd('a'),
        enPrep('b', h('12:35')),
        enPrep('c', h('12:45')), // au-delà de l'horizon, mais dans l'attente d'un trajet long (20 min)
        enPrep('p', h('12:51')), // au-delà des deux
        cmd('n', { sansCoordonnees: true }),
      ],
      courses: [
        crs('k1', { commandes: [cmd('d')] }),
        crs('k2', { statut: CourseStatut.AT_RESTAURANT, deliverer_id: 'd1', commandes: [cmd('e'), cmd('f', { est: 2100 })] }),
        crs('k3', { statut: CourseStatut.ACCEPTED, deliverer_id: 'd2', commandes: [cmd('g')] }),
        crs('k4', { turbo_escalated_at: h('12:20'), commandes: [cmd('t')] }),
      ],
    });
    const cles = pairesAEvaluer(inst).map(([x, y]) => clePaire(x.id, y.id)).sort();
    const avecC = ['a|c', 'b|c', 'c|d', 'c|e', 'c|f', 'c|g'];
    expect(cles).toEqual(
      ['a|b', 'a|d', 'b|d', 'a|e', 'a|f', 'b|e', 'b|f', 'd|e', 'd|f', 'e|f', 'a|g', 'b|g', 'd|g', ...avecC].sort(),
    );
    // Trajet long coupé : l'horizon seul, comme avant.
    expect(pairesAEvaluer(inst, COURT).map(([x, y]) => clePaire(x.id, y.id)).sort()).toEqual(
      ['a|b', 'a|d', 'b|d', 'a|e', 'a|f', 'b|e', 'b|f', 'd|e', 'd|f', 'e|f', 'a|g', 'b|g', 'd|g'].sort(),
    );
  });
});

// ─── Relecture du 23/10 : constats corrigés ─────────────────────────────────

describe('relecture du 23/10 : refus, Turbo, retard sans livreur libre, offre lointaine', () => {
  const occupe = (id: string, t: Date) => livr(id, t, { etat: { en_course: true, last_available_at: null } });

  it('commande prête jamais collée à une course que le seul livreur libre a refusée : elle lui est proposée seule', () => {
    const t = h('12:36');
    const k = crs('k', { commandes: [cmd('a', { ready_at: h('12:31'), est: 2000 })], created_at: h('12:31'), deja_sollicites: ['d1'] });
    const plan = planifier(
      instant(t, { commandes: [cmd('b', { ready_at: t, est: 2600 })], courses: [k], livreurs: [livr('d1', t, { auComptoir: true }), occupe('d2', t)] }),
    );
    expect(actionsDe(plan, 'AJOUTER')).toEqual([]);
    expect(refusDe(plan, 'b', 'k')).toEqual(['DEJA_REFUSEE']);
    expect(actionsDe(plan, 'CREER_COURSE')[0].order_ids).toEqual(['b']);
    expect(actionsDe(plan, 'OFFRIR')).toEqual([expect.objectContaining({ course_cle: 'nouvelle-1', deliverer_id: 'd1' })]);
  });

  it('fusion (demande 4) : une course refusée par le livreur libre ne se fond dans aucune autre ; la course neuve lui est proposée seule', () => {
    // Seconde relecture : fondre la course refusée dans la neuve lui reproposait la commande qu'il venait de refuser.
    const t = h('12:33');
    const u = crs('u', { commandes: [cmd('a', { ready_at: h('12:30'), est: 2000 })], created_at: h('12:30'), deja_sollicites: ['d1'] });
    const v = crs('v', { commandes: [cmd('b', { ready_at: h('12:32:50'), est: 2500 })], created_at: h('12:32:50') });
    const plan = planifier(instant(t, { courses: [u, v], livreurs: [livr('d1', t, { auComptoir: true }), occupe('d2', t)] }));
    expect(actionsDe(plan, 'FUSIONNER')).toEqual([]);
    expect(new Set([...refusDe(plan, 'u', 'v'), ...refusDe(plan, 'v', 'u')])).toEqual(new Set(['DEJA_REFUSEE']));
    expect(actionsDe(plan, 'OFFRIR')).toEqual([expect.objectContaining({ course_id: 'v', deliverer_id: 'd1' })]);
  });

  it('Turbo : une commande prête n’est pas collée à une course sans livreur qui partira chez Turbo bien avant elle', () => {
    const t = h('12:35');
    const u = () => crs('u', { commandes: [cmd('a', { ready_at: h('12:30'), created_at: h('12:20'), est: 2000 })], created_at: h('12:30') });
    const b = cmd('b', { ready_at: t, created_at: h('12:25'), est: 2500 });
    const plan = planifier(instant(t, { commandes: [b], courses: [u()], livreurs: [occupe('d1', t), occupe('d2', t)] }));
    expect(actionsDe(plan, 'AJOUTER')).toEqual([]);
    expect(refusDe(plan, 'b', 'u')).toEqual(['AVANCE_TURBO']);
    expect(actionsDe(plan, 'CREER_COURSE')[0].order_ids).toEqual(['b']);
    // Turbo désactivé : le regroupement reprend.
    const sansTurbo = planifier(instant(t, { commandes: [b], courses: [u()], livreurs: [occupe('d1', t), occupe('d2', t)] }), avec({ turboActif: false }));
    expect(actionsDe(sansTurbo, 'AJOUTER')).toEqual([expect.objectContaining({ course_id: 'u', order_id: 'b' })]);
  });

  it('Turbo : regroupement permis quand le premier livreur revient avant la bascule', () => {
    const t = h('12:35');
    // D1 revient à vide, à 700 m : de retour vers 12:38:40 ; A part chez Turbo à 12:39 au plus tôt.
    const k1 = crs('k1', {
      statut: CourseStatut.IN_DELIVERY,
      deliverer_id: 'd1',
      picked_up_at: h('12:10'),
      parti_at: h('12:11'),
      livraisons: [{ id: 'l1', statut: DeliveryStatut.DELIVERED, sequence_order: 1, commande: cmd('x', { statut: OrderStatus.PICKED_UP, est: -1500 }) }],
    });
    const d1 = livr('d1', t, { aEst: -700, etat: { en_course: true, last_available_at: null } });
    const u = crs('u', { commandes: [cmd('a', { ready_at: h('12:33'), created_at: h('12:20'), est: 2000 })], created_at: h('12:33') });
    const plan = planifier(instant(t, { commandes: [cmd('b', { ready_at: t, created_at: h('12:25'), est: 2500 })], courses: [u, k1], livreurs: [d1] }));
    expect(actionsDe(plan, 'AJOUTER')).toEqual([expect.objectContaining({ course_id: 'u', order_id: 'b' })]);
  });

  it('retard toléré : avec deux livreurs sur le retour, une fusion qui met un client en retard est refusée comme avec un livreur libre', () => {
    const t = h('12:31');
    const u = crs('u', { commandes: [cmd('a', { ready_at: h('12:30'), created_at: h('12:20'), est: 3000 })], created_at: h('12:30') });
    const v = crs('v', { commandes: [cmd('b', { ready_at: h('12:31'), created_at: h('12:12'), est: 3800 })], created_at: h('12:31') });
    const k1 = crs('k1', {
      statut: CourseStatut.IN_DELIVERY,
      deliverer_id: 'd1',
      picked_up_at: h('12:10'),
      parti_at: h('12:11'),
      livraisons: [{ id: 'l1', statut: DeliveryStatut.DELIVERED, sequence_order: 1, commande: cmd('x', { statut: OrderStatus.PICKED_UP, est: -1500 }) }],
    });
    const enRetour = (id: string, est: number) => livr(id, t, { aEst: est, etat: { en_course: true, last_available_at: null } });
    const plan = planifier(instant(t, { courses: [u, v, k1], livreurs: [enRetour('d1', -700), enRetour('d2', -900)] }));
    expect(actionsDe(plan, 'FUSIONNER')).toEqual([]);
    expect(plan.refus.some((x) => x.essai === 'FUSION' && x.refus === 'RETARD_CLIENT')).toBe(true);
  });

  it('zéro temps mort : l’offre d’un livreur loin est reprise pour le livreur au comptoir ; pas pour un écart de moins de 2 min', () => {
    const t = h('12:31');
    const offre = { id: 'o1', deliverer_id: 'd1', expires_at: h('12:32') };
    const u = () => crs('u', { commandes: [cmd('a', { ready_at: h('12:30'), est: 2000 })], offre });
    const loin = livr('d1', t, { aEst: -6000, etat: { offre_en_attente: true } });
    const plan = planifier(instant(t, { courses: [u()], livreurs: [loin, livr('d2', t, { auComptoir: true })] }));
    expect(types(plan)).toEqual(['REPRENDRE_OFFRE', 'OFFRIR']);
    expect(actionsDe(plan, 'REPRENDRE_OFFRE')[0]).toMatchObject({ course_id: 'u', offre, pour_deliverer_id: 'd2' });
    expect(actionsDe(plan, 'OFFRIR')[0]).toMatchObject({ course_id: 'u', deliverer_id: 'd2' });

    // À 400 m (moins de 2 min de plus que le livreur au comptoir) : l'offre reste au livreur sollicité.
    const proche = livr('d1', t, { aEst: -400, etat: { offre_en_attente: true } });
    expect(types(planifier(instant(t, { courses: [u()], livreurs: [proche, livr('d2', t, { auComptoir: true })] })))).toEqual([]);
    // Livreur libre hors du comptoir : il faut 5 min d'écart (1 km contre 400 m : rien).
    const d1Km = livr('d1', t, { aEst: -1000, etat: { offre_en_attente: true } });
    expect(types(planifier(instant(t, { courses: [u()], livreurs: [d1Km, livr('d2', t, { aEst: 400 })] })))).toEqual([]);
    // Livreur libre qui a déjà refusé la course : rien.
    const refusee = { ...u(), deja_sollicites: ['d2'] };
    expect(types(planifier(instant(t, { courses: [refusee], livreurs: [loin, livr('d2', t, { auComptoir: true })] })))).toEqual([]);
    // Offre déjà échue (pas encore traitée) : son expiration passe d'abord, avec sa pénalité.
    const echue = crs('u', { commandes: [cmd('a', { ready_at: h('12:30'), est: 2000 })], offre: { ...offre, expires_at: t } });
    expect(types(planifier(instant(t, { courses: [echue], livreurs: [loin, livr('d2', t, { auComptoir: true })] })))).toEqual([]);
  });
});
