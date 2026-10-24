/**
 * Tableau de la livraison (conception du 24/10, 11.4 et 11.8) : chaque
 * signal et son seuil, restaurant sans livreur, sans planning, journée de
 * service à 04 h 59 et 05 h 00, place dans la file par restaurant.
 */
import { CourseStatut, DeliveryStatut, EntityStatus, OrderStatus, ShiftAssignmentStatus, ShiftType } from '@prisma/client';

import type { EtatAffichageLivreur } from 'src/modules/deliverers/helpers/disponibilite.rules';
import {
  PlanningDuJourLu,
  bornesDuCreneau,
  creneauDuJour,
  jourDuPlanning,
} from 'src/modules/deliverers/helpers/planning-du-jour.rules';
import { rangsDansLaFile } from 'src/modules/deliverers/helpers/rang-file.rules';

import {
  CleSignal,
  CourseLue,
  EntreeTableau,
  LivreurLu,
  TableauLivraison,
  construireTableau,
} from './tableau-livraison.rules';

const M = new Date('2026-10-24T12:00:00.000Z');
const JOUR = new Date('2026-10-24T00:00:00.000Z');
const ilYA = (min: number, base: Date = M) => new Date(base.getTime() - min * 60_000);
const REGLAGES = { facteurRetard: 1.5, sansLivreurAlerteMin: 5, attenteAuRestaurantMin: 15, positionExpireeMin: 5 };
const ANGRE = { id: 'r-angre', nom: 'Angré' };
const MARCORY = { id: 'r-marcory', nom: 'Marcory' };

let n = 0;

function livreur(p: Partial<LivreurLu> & { etat?: EtatAffichageLivreur } = {}): LivreurLu {
  const { etat = 'DISPONIBLE', ...reste } = p;
  n += 1;
  return {
    id: `l-${n}`,
    first_name: 'Awa',
    restaurant: { id: ANGRE.id },
    disponibilite: { etat },
    rang_file: null,
    appli_active: true,
    appli_vue_a: null,
    location_at: M.toISOString(),
    active_course: null,
    ...reste,
  };
}

type LivraisonLue = CourseLue['deliveries'][number];

function livraison(p: Partial<Omit<LivraisonLue, 'order'>> & { order?: Partial<LivraisonLue['order']> } = {}): LivraisonLue {
  n += 1;
  const { order, ...reste } = p;
  return {
    statut: DeliveryStatut.PENDING,
    ajoutee_apres_retrait: false,
    order: { reference: `ORD-${n}`, status: OrderStatus.READY, entity_status: EntityStatus.ACTIVE, ...order },
    ...reste,
  };
}

function course(p: Partial<CourseLue> = {}): CourseLue {
  n += 1;
  return {
    id: `c-${n}`,
    reference: `CRS-241024-${String(n).padStart(4, '0')}`,
    statut: CourseStatut.PENDING_ASSIGNMENT,
    restaurant_id: ANGRE.id,
    deliverer: null,
    turbo_escalated_at: null,
    created_at: M,
    at_restaurant_at: null,
    picked_up_at: null,
    parti_at: null,
    motif_depart: null,
    estimated_duration_min: null,
    delay_alerted_at: null,
    cancelled_at: null,
    deliveries: [livraison()],
    ...p,
  };
}

const KOFFI = { id: 'l-koffi', first_name: 'Koffi' };

function planning(p: {
  jour?: Date;
  restaurant?: string;
  shifts?: Array<{ type: ShiftType; start: string; end: string; affectes: Array<[string, ShiftAssignmentStatus?]> }>;
  repos?: string[];
  absents?: string[];
} = {}): PlanningDuJourLu {
  return {
    jour: p.jour ?? JOUR,
    plans: [
      {
        id: 'plan-1',
        restaurant_id: p.restaurant ?? ANGRE.id,
        shifts: (p.shifts ?? []).map((s) => ({
          type: s.type,
          start_time: s.start,
          end_time: s.end,
          assignments: s.affectes.map(([deliverer_id, status]) => ({
            deliverer_id,
            status: status ?? ShiftAssignmentStatus.ASSIGNED,
          })),
        })),
      },
    ],
    repos: p.repos ?? [],
    absents: p.absents ?? [],
  };
}

const SANS_PLANNING: PlanningDuJourLu = { jour: JOUR, plans: [], repos: [], absents: [] };

function tableau(p: Partial<EntreeTableau> = {}): TableauLivraison {
  return construireTableau({
    maintenant: M,
    reglages: REGLAGES,
    restaurants: [ANGRE, MARCORY],
    livreurs: [],
    courses: [],
    aEncaisser: [],
    livrees: [],
    planning: SANS_PLANNING,
    ...p,
  });
}

const signaux = (t: TableauLivraison, cle: CleSignal) => t.signaux.filter((s) => s.cle === cle);
const angre = (t: TableauLivraison) => t.restaurants.find((r) => r.id === ANGRE.id)!;
const marcory = (t: TableauLivraison) => t.restaurants.find((r) => r.id === MARCORY.id)!;

describe('restaurants : chiffres et liste', () => {
  it('restaurant sans livreur ni planning : zéros, liste vide, prévus null, aucune alerte', () => {
    const t = tableau();
    expect(t.genere_a).toBe(M.toISOString());
    expect(marcory(t)).toEqual({
      id: MARCORY.id,
      nom: 'Marcory',
      livreurs: { disponibles: 0, en_course: 0, en_pause: 0, appli_fermee: 0, en_service: 0, prevus: null },
      sans_livreur: { courses: 0, plus_ancienne_depuis: null },
      jour: { livrees: 0, duree_moyenne_s: null },
      alertes: 0,
      liste: [],
    });
    expect(t.signaux).toEqual([]);
  });

  it('compte chaque état dans son chiffre ; en service : tous sauf hors service et inactif', () => {
    const etats: EtatAffichageLivreur[] = [
      'DISPONIBLE',
      'OFFRE_EN_ATTENTE',
      'EN_APPEL',
      'EN_COURSE',
      'EN_PAUSE',
      'PAUSE_AUTO',
      'APPLI_FERMEE',
      'INJOIGNABLE',
      'HORS_SERVICE',
      'HORS_SERVICE',
    ];
    const t = tableau({ livreurs: etats.map((etat) => livreur({ etat })) });
    expect(angre(t).livreurs).toEqual({
      disponibles: 3,
      en_course: 1,
      en_pause: 2,
      appli_fermee: 2,
      en_service: 8,
      prevus: null,
    });
    expect(marcory(t).livreurs.en_service).toBe(0);
  });

  it('liste : disponibles d’abord dans l’ordre de la file, puis les autres états ; course résumée', () => {
    const t = tableau({
      livreurs: [
        livreur({ id: 'yao', first_name: 'Yao', etat: 'HORS_SERVICE' }),
        livreur({
          id: 'awa',
          first_name: 'Awa',
          etat: 'EN_COURSE',
          active_course: { id: 'c-a', reference: 'CRS-241024-0040', statut: CourseStatut.IN_DELIVERY },
        }),
        livreur({ id: 'moussa', first_name: 'Moussa', rang_file: 2 }),
        livreur({ id: 'ines', first_name: 'Inès', rang_file: 1 }),
        livreur({ id: 'zoe', first_name: 'Zoé', restaurant: { id: MARCORY.id }, rang_file: 1 }),
      ],
    });
    expect(angre(t).liste).toEqual([
      { id: 'ines', prenom: 'Inès', etat: 'DISPONIBLE', rang_file: 1, course: null },
      { id: 'moussa', prenom: 'Moussa', etat: 'DISPONIBLE', rang_file: 2, course: null },
      {
        id: 'awa',
        prenom: 'Awa',
        etat: 'EN_COURSE',
        rang_file: null,
        course: { reference: 'CRS-241024-0040', statut: CourseStatut.IN_DELIVERY },
      },
      { id: 'yao', prenom: 'Yao', etat: 'HORS_SERVICE', rang_file: null, course: null },
    ]);
    expect(marcory(t).liste.map((l) => l.id)).toEqual(['zoe']);
  });

  it('livrées du jour et durée moyenne de la commande prête à la livraison', () => {
    const t = tableau({
      livrees: [
        { restaurant_id: ANGRE.id, ready_at: ilYA(130), delivered_at: ilYA(100) },
        { restaurant_id: ANGRE.id, ready_at: ilYA(60), delivered_at: ilYA(20) },
        // Sans heure de commande prête : comptée, pas dans la moyenne.
        { restaurant_id: ANGRE.id, ready_at: null, delivered_at: ilYA(10) },
        { restaurant_id: MARCORY.id, ready_at: ilYA(40), delivered_at: ilYA(9) },
      ],
    });
    expect(angre(t).jour).toEqual({ livrees: 3, duree_moyenne_s: 35 * 60 });
    expect(marcory(t).jour).toEqual({ livrees: 1, duree_moyenne_s: 31 * 60 });
  });

  it('un signal d’un restaurant hors du périmètre lu n’est pas renvoyé', () => {
    const t = tableau({
      restaurants: [ANGRE],
      courses: [course({ restaurant_id: MARCORY.id, statut: CourseStatut.EXPIRED, created_at: ilYA(60) })],
    });
    expect(t.signaux).toEqual([]);
    expect(t.restaurants.map((r) => r.id)).toEqual([ANGRE.id]);
  });
});

describe('PLACE DANS LA FILE, par restaurant', () => {
  it('chaque restaurant a son 1er de la file ; seuls les « Disponible » ont une place', () => {
    const rangs = rangsDansLaFile([
      { id: 'awa', restaurant_id: ANGRE.id, etat: 'DISPONIBLE', last_available_at: new Date('2026-10-24T10:00:00Z') },
      { id: 'koffi', restaurant_id: ANGRE.id, etat: 'DISPONIBLE', last_available_at: new Date('2026-10-24T09:00:00Z') },
      { id: 'ines', restaurant_id: ANGRE.id, etat: 'OFFRE_EN_ATTENTE', last_available_at: new Date('2026-10-24T08:00:00Z') },
      { id: 'fanta', restaurant_id: ANGRE.id, etat: 'APPLI_FERMEE', last_available_at: new Date('2026-10-24T07:00:00Z') },
      { id: 'moussa', restaurant_id: MARCORY.id, etat: 'DISPONIBLE', last_available_at: '2026-10-24T11:00:00.000Z' },
      { id: 'yao', restaurant_id: MARCORY.id, etat: 'EN_PAUSE', last_available_at: null },
    ]);
    expect(Object.fromEntries(rangs)).toEqual({ koffi: 1, awa: 2, moussa: 1 });
  });
});

describe('TOURNEE_EN_RETARD (course.delay_alert_factor)', () => {
  const enLivraison = (retraitIlYA: number, partiIlYA: number, p: Partial<CourseLue> = {}) =>
    course({
      statut: CourseStatut.IN_DELIVERY,
      deliverer: KOFFI,
      picked_up_at: ilYA(retraitIlYA),
      parti_at: ilYA(partiIlYA),
      motif_depart: 'POSITION',
      estimated_duration_min: 30,
      deliveries: [
        livraison({ statut: DeliveryStatut.DELIVERED, order: { reference: 'ORD-1', status: OrderStatus.COLLECTED } }),
        livraison({ statut: DeliveryStatut.IN_ROUTE, order: { reference: 'ORD-2', status: OrderStatus.PICKED_UP } }),
      ],
      ...p,
    });

  it('44 min pour 30 estimées (facteur 1,5 : seuil 45) : rien ; 45 min : rouge, minutes au-delà de la fin prévue', () => {
    expect(signaux(tableau({ courses: [enLivraison(44, 40)] }), 'TOURNEE_EN_RETARD')).toEqual([]);

    const c = enLivraison(45, 40);
    const [s] = signaux(tableau({ courses: [c] }), 'TOURNEE_EN_RETARD');
    expect(s).toEqual({
      cle: 'TOURNEE_EN_RETARD',
      gravite: 'rouge',
      restaurant_id: ANGRE.id,
      depuis: ilYA(10).toISOString(),
      minutes: 10,
      course: { id: c.id, reference: c.reference, statut: CourseStatut.IN_DELIVERY, expiree: false },
      livreur: { id: 'l-koffi', prenom: 'Koffi' },
      commandes: ['ORD-2'],
    });
  });

  it('alerte déjà donnée par la tâche : en retard ; livreur pas encore parti : retard sans minutes', () => {
    const c = enLivraison(10, 10, { parti_at: null, motif_depart: null, delay_alerted_at: ilYA(1) });
    const [s] = signaux(tableau({ courses: [c] }), 'TOURNEE_EN_RETARD');
    expect(s).toMatchObject({ gravite: 'rouge', depuis: null, minutes: null });
  });

  it('compte dans les alertes rouges du restaurant', () => {
    expect(angre(tableau({ courses: [enLivraison(60, 55)] })).alertes).toBe(1);
  });
});

describe('SANS_LIVREUR (course.no_deliverer_alert_after_min)', () => {
  it('recherche depuis 4 min : ambre ; depuis 5 min : rouge ; chiffres du bandeau', () => {
    const recente = course({ created_at: ilYA(4) });
    const ancienne = course({ created_at: ilYA(5), deliveries: [livraison(), livraison()] });
    const t = tableau({ courses: [recente, ancienne] });
    const s = signaux(t, 'SANS_LIVREUR');
    expect(s.map((x) => [x.course?.id, x.gravite, x.minutes, x.commandes.length])).toEqual([
      [ancienne.id, 'rouge', 5, 2],
      [recente.id, 'ambre', 4, 1],
    ]);
    expect(angre(t).sans_livreur).toEqual({ courses: 2, plus_ancienne_depuis: ilYA(5).toISOString() });
    expect(angre(t).alertes).toBe(1);
  });

  it('expirée dans la journée : rouge, « aucun livreur trouvé » (expiree)', () => {
    const c = course({ statut: CourseStatut.EXPIRED, created_at: ilYA(70) });
    const [s] = signaux(tableau({ courses: [c] }), 'SANS_LIVREUR');
    expect(s).toMatchObject({ gravite: 'rouge', course: { id: c.id, expiree: true, statut: CourseStatut.EXPIRED } });
  });

  it('pas sans livreur : confiée à Turbo, livreur trouvé, commandes toutes annulées ou supprimées', () => {
    const t = tableau({
      courses: [
        course({ turbo_escalated_at: ilYA(2) }),
        course({ deliverer: KOFFI }),
        course({
          deliveries: [
            livraison({ order: { status: OrderStatus.CANCELLED } }),
            livraison({ statut: DeliveryStatut.CANCELLED }),
            livraison({ order: { entity_status: EntityStatus.DELETED } }),
          ],
        }),
      ],
    });
    expect(signaux(t, 'SANS_LIVREUR')).toEqual([]);
    expect(angre(t).sans_livreur.courses).toBe(0);
  });
});

describe('PARTI_SANS_SAC (même règle que la cloche du sac oublié)', () => {
  const partie = (p: Partial<CourseLue>) =>
    course({
      statut: CourseStatut.IN_DELIVERY,
      deliverer: KOFFI,
      picked_up_at: ilYA(12),
      parti_at: ilYA(8),
      motif_depart: 'POSITION',
      estimated_duration_min: 30,
      ...p,
    });

  it('départ réel avec une commande d’origine encore prête : rouge, depuis le départ', () => {
    const c = partie({
      deliveries: [
        livraison({ statut: DeliveryStatut.IN_ROUTE, order: { status: OrderStatus.PICKED_UP } }),
        livraison({ order: { reference: 'ORD-4822', status: OrderStatus.READY } }),
      ],
    });
    const [s] = signaux(tableau({ courses: [c] }), 'PARTI_SANS_SAC');
    expect(s).toMatchObject({
      gravite: 'rouge',
      depuis: ilYA(8).toISOString(),
      minutes: 8,
      livreur: { prenom: 'Koffi' },
      commandes: ['ORD-4822'],
    });
  });

  it('rien : commande ajoutée après le retrait (détachée au départ), départ noté sans être réel', () => {
    const ajoutee = partie({ deliveries: [livraison({ ajoutee_apres_retrait: true })] });
    const pasReel = partie({ motif_depart: 'ANCIENNE_APPLI', deliveries: [livraison()] });
    expect(signaux(tableau({ courses: [ajoutee, pasReel] }), 'PARTI_SANS_SAC')).toEqual([]);
  });
});

describe('COURSE_ANNULEE_A_RELANCER', () => {
  it('annulée dans la journée, livraison annulée et commande encore prête : rouge', () => {
    const c = course({
      statut: CourseStatut.CANCELLED,
      cancelled_at: ilYA(20),
      deliveries: [
        livraison({ statut: DeliveryStatut.CANCELLED, order: { reference: 'ORD-4790' } }),
        livraison({ statut: DeliveryStatut.CANCELLED, order: { status: OrderStatus.CANCELLED } }),
      ],
    });
    const [s] = signaux(tableau({ courses: [c] }), 'COURSE_ANNULEE_A_RELANCER');
    expect(s).toMatchObject({ gravite: 'rouge', minutes: 20, livreur: null, commandes: ['ORD-4790'] });
  });

  it('rien quand les commandes sont annulées ou déjà relancées', () => {
    const c = course({
      statut: CourseStatut.CANCELLED,
      cancelled_at: ilYA(20),
      deliveries: [livraison({ statut: DeliveryStatut.CANCELLED, order: { status: OrderStatus.CANCELLED } })],
    });
    const vide = course({ statut: CourseStatut.CANCELLED, cancelled_at: ilYA(20), deliveries: [] });
    expect(signaux(tableau({ courses: [c, vide] }), 'COURSE_ANNULEE_A_RELANCER')).toEqual([]);
  });
});

describe('ATTENTE_AU_RESTAURANT (moitié de course.auto_cancel_at_restaurant_after_min)', () => {
  const auComptoir = (min: number) =>
    course({ statut: CourseStatut.AT_RESTAURANT, deliverer: KOFFI, at_restaurant_at: ilYA(min) });

  it('14 min : rien ; 15 min : ambre ; course récupérée : rien', () => {
    expect(signaux(tableau({ courses: [auComptoir(14)] }), 'ATTENTE_AU_RESTAURANT')).toEqual([]);
    const [s] = signaux(tableau({ courses: [auComptoir(15)] }), 'ATTENTE_AU_RESTAURANT');
    expect(s).toMatchObject({ gravite: 'ambre', minutes: 15, livreur: { prenom: 'Koffi' } });
    const recuperee = course({
      statut: CourseStatut.IN_DELIVERY,
      deliverer: KOFFI,
      at_restaurant_at: ilYA(30),
      picked_up_at: ilYA(1),
    });
    expect(signaux(tableau({ courses: [recuperee] }), 'ATTENTE_AU_RESTAURANT')).toEqual([]);
  });
});

describe('APPLI_FERMEE_EN_COURSE et POSITION_PERDUE_EN_COURSE', () => {
  const enCourse = { id: 'c-x', reference: 'CRS-241024-0044', statut: CourseStatut.IN_DELIVERY };

  it('appli fermée pendant une course : ambre, vue il y a 6 min ; la position perdue n’est pas répétée', () => {
    const l = livreur({
      first_name: 'Moussa',
      etat: 'EN_COURSE',
      active_course: enCourse,
      appli_active: false,
      appli_vue_a: ilYA(6).toISOString(),
      location_at: ilYA(6).toISOString(),
    });
    const t = tableau({ livreurs: [l] });
    expect(t.signaux).toEqual([
      {
        cle: 'APPLI_FERMEE_EN_COURSE',
        gravite: 'ambre',
        restaurant_id: ANGRE.id,
        depuis: ilYA(6).toISOString(),
        minutes: 6,
        course: { ...enCourse, expiree: false },
        livreur: { id: l.id, prenom: 'Moussa' },
        commandes: [],
        appli_vue_a: ilYA(6).toISOString(),
      },
    ]);
  });

  it('position de 5 min (deliverer.gps_expiration_minutes) : rien ; 6 min : ambre ; jamais reçue : ambre sans heure', () => {
    const position = (min: number | null) =>
      livreur({ etat: 'EN_COURSE', active_course: enCourse, location_at: min === null ? null : ilYA(min).toISOString() });
    expect(tableau({ livreurs: [position(5)] }).signaux).toEqual([]);
    expect(signaux(tableau({ livreurs: [position(6)] }), 'POSITION_PERDUE_EN_COURSE')[0]).toMatchObject({
      gravite: 'ambre',
      minutes: 6,
    });
    expect(signaux(tableau({ livreurs: [position(null)] }), 'POSITION_PERDUE_EN_COURSE')[0]).toMatchObject({
      depuis: null,
      minutes: null,
    });
  });

  it('sans course : ni l’un ni l’autre ; règle de l’appli coupée (null) : pas d’appli fermée', () => {
    const t = tableau({
      livreurs: [
        livreur({ appli_active: false, location_at: null }),
        livreur({ etat: 'EN_COURSE', active_course: enCourse, appli_active: null }),
      ],
    });
    expect(t.signaux).toEqual([]);
  });
});

describe('A_ENCAISSER (60 min, comme l’écran Commandes)', () => {
  it('59 min : rien ; 60 min : ambre, les commandes du livreur regroupées, depuis la plus ancienne', () => {
    const koffi = { id: 'l-koffi', first_name: 'Koffi' };
    const avant = tableau({
      aEncaisser: [{ reference: 'ORD-1', restaurant_id: ANGRE.id, collected_at: ilYA(59), livreur: koffi }],
    });
    expect(avant.signaux).toEqual([]);

    const t = tableau({
      aEncaisser: [
        { reference: 'ORD-1', restaurant_id: ANGRE.id, collected_at: ilYA(65), livreur: koffi },
        { reference: 'ORD-2', restaurant_id: ANGRE.id, collected_at: ilYA(10), livreur: koffi },
        { reference: 'ORD-3', restaurant_id: ANGRE.id, collected_at: ilYA(90), livreur: null },
        { reference: 'ORD-4', restaurant_id: ANGRE.id, collected_at: ilYA(30), livreur: { id: 'l-awa', first_name: 'Awa' } },
      ],
    });
    expect(t.signaux).toEqual([
      {
        cle: 'A_ENCAISSER',
        gravite: 'ambre',
        restaurant_id: ANGRE.id,
        depuis: ilYA(65).toISOString(),
        minutes: 65,
        course: null,
        livreur: { id: 'l-koffi', prenom: 'Koffi' },
        commandes: ['ORD-1', 'ORD-2'],
      },
    ]);
  });
});

describe('PREVU_PAS_EN_SERVICE (15 min après le début du créneau)', () => {
  const MATIN = { type: ShiftType.MORNING, start: '09:00', end: '15:00' };
  const SOIR = { type: ShiftType.EVENING, start: '15:00', end: '23:00' };
  const a = (hhmm: string) => new Date(`2026-10-24T${hhmm}:00.000Z`);
  const ibrahim = (etat: EtatAffichageLivreur = 'HORS_SERVICE') => livreur({ id: 'ibrahim', first_name: 'Ibrahim', etat });

  it('créneau du matin commencé depuis 14 min : rien ; 15 min : ambre, créneau MORNING', () => {
    const p = planning({ shifts: [{ ...MATIN, affectes: [['ibrahim']] }] });
    expect(tableau({ maintenant: a('09:14'), livreurs: [ibrahim()], planning: p }).signaux).toEqual([]);
    const t = tableau({ maintenant: a('09:15'), livreurs: [ibrahim()], planning: p });
    expect(t.signaux).toEqual([
      {
        cle: 'PREVU_PAS_EN_SERVICE',
        gravite: 'ambre',
        restaurant_id: ANGRE.id,
        depuis: a('09:00').toISOString(),
        minutes: 15,
        course: null,
        livreur: { id: 'ibrahim', prenom: 'Ibrahim' },
        commandes: [],
        creneau: ShiftType.MORNING,
      },
    ]);
  });

  it('le soir : créneau EVENING ; matin fini et pas prévu le soir : rien', () => {
    const lesDeux = planning({ shifts: [{ ...MATIN, affectes: [['ibrahim']] }, { ...SOIR, affectes: [['ibrahim']] }] });
    expect(tableau({ maintenant: a('16:00'), livreurs: [ibrahim()], planning: lesDeux }).signaux[0]?.creneau).toBe(
      ShiftType.EVENING,
    );
    const matinSeul = planning({ shifts: [{ ...MATIN, affectes: [['ibrahim']] }] });
    expect(tableau({ maintenant: a('16:00'), livreurs: [ibrahim()], planning: matinSeul }).signaux).toEqual([]);
  });

  it('rien : en service, en pause, refusé, au repos, livreur qui n’est plus actif', () => {
    const p = (statut?: ShiftAssignmentStatus, repos: string[] = []) =>
      planning({ shifts: [{ ...MATIN, affectes: [['ibrahim', statut]] }], repos });
    const m = a('10:00');
    expect(tableau({ maintenant: m, livreurs: [ibrahim('DISPONIBLE')], planning: p() }).signaux).toEqual([]);
    expect(tableau({ maintenant: m, livreurs: [ibrahim('EN_PAUSE')], planning: p() }).signaux).toEqual([]);
    expect(
      tableau({ maintenant: m, livreurs: [ibrahim()], planning: p(ShiftAssignmentStatus.REFUSED) }).signaux,
    ).toEqual([]);
    expect(tableau({ maintenant: m, livreurs: [ibrahim()], planning: p(undefined, ['ibrahim']) }).signaux).toEqual([]);
    expect(tableau({ maintenant: m, livreurs: [], planning: p() }).signaux).toEqual([]);
  });

  it('« Non » au point du matin : signalé avant le début du créneau, sans heure', () => {
    const p = planning({ shifts: [{ ...MATIN, affectes: [['ibrahim']] }], absents: ['ibrahim'] });
    const [s] = tableau({ maintenant: a('08:10'), livreurs: [ibrahim()], planning: p }).signaux;
    expect(s).toMatchObject({ cle: 'PREVU_PAS_EN_SERVICE', creneau: ShiftType.MORNING, depuis: null, minutes: null });
  });
});

describe('planning du jour', () => {
  it('sans planning : prévus null ; planning sans personne aujourd’hui : 0', () => {
    expect(angre(tableau()).livreurs.prevus).toBeNull();
    expect(angre(tableau({ planning: planning() })).livreurs.prevus).toBe(0);
    expect(marcory(tableau({ planning: planning() })).livreurs.prevus).toBeNull();
  });

  it('prévus : livreurs distincts, pas refusés, pas au repos', () => {
    const p = planning({
      shifts: [
        { type: ShiftType.MORNING, start: '09:00', end: '15:00', affectes: [['awa'], ['koffi', ShiftAssignmentStatus.CONFIRMED], ['yao', ShiftAssignmentStatus.REFUSED]] },
        { type: ShiftType.EVENING, start: '15:00', end: '23:00', affectes: [['awa'], ['ines'], ['diane']] },
      ],
      repos: ['diane'],
    });
    expect(angre(tableau({ planning: p })).livreurs.prevus).toBe(3);
    expect(creneauDuJour(p, 'awa')).toEqual({
      matin: ShiftAssignmentStatus.ASSIGNED,
      soir: ShiftAssignmentStatus.ASSIGNED,
      repos: false,
    });
    expect(creneauDuJour(p, 'yao')).toEqual({ matin: ShiftAssignmentStatus.REFUSED, soir: null, repos: false });
    expect(creneauDuJour(p, 'diane')).toEqual({ matin: null, soir: ShiftAssignmentStatus.ASSIGNED, repos: true });
    expect(creneauDuJour(p, 'personne')).toEqual({ matin: null, soir: null, repos: false });
  });

  it('créneau de nuit : la fin passe au lendemain', () => {
    expect(bornesDuCreneau(JOUR, '18:00', '02:00')).toEqual({
      debut: new Date('2026-10-24T18:00:00.000Z'),
      fin: new Date('2026-10-25T02:00:00.000Z'),
    });
    expect(bornesDuCreneau(JOUR, '9h', '15:00')).toBeNull();
  });
});

describe('journée de service : 04 h 59 et 05 h 00', () => {
  const A_04H59 = new Date('2026-10-25T04:59:00.000Z');
  const A_05H00 = new Date('2026-10-25T05:00:00.000Z');
  const entree = (maintenant: Date): Partial<EntreeTableau> => ({
    maintenant,
    livrees: [
      {
        restaurant_id: ANGRE.id,
        ready_at: new Date('2026-10-24T19:30:00.000Z'),
        delivered_at: new Date('2026-10-24T20:00:00.000Z'),
      },
    ],
    courses: [
      course({ statut: CourseStatut.EXPIRED, created_at: new Date('2026-10-24T22:00:00.000Z') }),
      course({
        statut: CourseStatut.CANCELLED,
        cancelled_at: new Date('2026-10-24T23:00:00.000Z'),
        deliveries: [livraison({ statut: DeliveryStatut.CANCELLED })],
      }),
    ],
  });

  it('à 04 h 59 : encore la journée du 24 (livrée, expirée, annulée comptées ; planning du 24)', () => {
    const t = tableau(entree(A_04H59));
    expect(angre(t).jour).toEqual({ livrees: 1, duree_moyenne_s: 1800 });
    expect(t.signaux.map((s) => s.cle).sort()).toEqual(['COURSE_ANNULEE_A_RELANCER', 'SANS_LIVREUR']);
    expect(jourDuPlanning(A_04H59)).toEqual(new Date('2026-10-24T00:00:00.000Z'));
  });

  it('à 05 h 00 : nouvelle journée, tout repart à zéro ; planning du 25', () => {
    const t = tableau(entree(A_05H00));
    expect(angre(t).jour).toEqual({ livrees: 0, duree_moyenne_s: null });
    expect(t.signaux).toEqual([]);
    expect(jourDuPlanning(A_05H00)).toEqual(new Date('2026-10-25T00:00:00.000Z'));
  });
});

describe('ordre des signaux', () => {
  it('rouges d’abord, puis le plus ancien ; les alertes du bandeau ne comptent que les rouges', () => {
    const t = tableau({
      courses: [
        course({ statut: CourseStatut.AT_RESTAURANT, deliverer: KOFFI, at_restaurant_at: ilYA(40) }),
        course({ created_at: ilYA(6) }),
        course({ statut: CourseStatut.EXPIRED, created_at: ilYA(70), restaurant_id: MARCORY.id }),
      ],
    });
    expect(t.signaux.map((s) => [s.cle, s.gravite, s.restaurant_id])).toEqual([
      ['SANS_LIVREUR', 'rouge', MARCORY.id],
      ['SANS_LIVREUR', 'rouge', ANGRE.id],
      ['ATTENTE_AU_RESTAURANT', 'ambre', ANGRE.id],
    ]);
    expect([angre(t).alertes, marcory(t).alertes]).toEqual([1, 1]);
  });
});
