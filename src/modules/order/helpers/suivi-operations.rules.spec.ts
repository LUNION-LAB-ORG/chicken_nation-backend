import {
  coursesQuiAttendentUnSac,
  enrichirCommandesOperations,
  enrichirCourseOperations,
  lireAppliFermeeApresS,
  lireFacteurRetard,
  livreursDesCommandes,
} from './suivi-operations.rules';

const MAINTENANT = new Date('2026-10-23T12:30:00.000Z');
const p = { maintenant: MAINTENANT, fenetreMaxS: 240 };

describe('écran Opérations : offre en attente nommée', () => {
  it('course en recherche, offre en attente : prénom et échéance ; offer_attempts retirées de la réponse', () => {
    const r = enrichirCourseOperations(
      {
        statut: 'PENDING_ASSIGNMENT',
        offer_attempts: [{ expires_at: new Date('2026-10-23T12:31:30.000Z'), deliverer: { first_name: ' Koffi ' } }],
      },
      p,
    );
    expect(r.offre_en_cours).toEqual({ prenom: 'Koffi', expires_at: '2026-10-23T12:31:30.000Z' });
    expect('offer_attempts' in r).toBe(false);
  });

  it('offre échue, aucune offre, ou course déjà acceptée : rien', () => {
    expect(
      enrichirCourseOperations({ statut: 'PENDING_ASSIGNMENT', offer_attempts: [{ expires_at: '2026-10-23T12:29:00.000Z' }] }, p)
        .offre_en_cours,
    ).toBeNull();
    expect(enrichirCourseOperations({ statut: 'PENDING_ASSIGNMENT', offer_attempts: [] }, p).offre_en_cours).toBeNull();
    expect(
      enrichirCourseOperations({ statut: 'ACCEPTED', offer_attempts: [{ expires_at: '2026-10-23T12:31:00.000Z' }] }, p).offre_en_cours,
    ).toBeNull();
  });
});

describe('écran Opérations : fin de la fenêtre d’ajout après le retrait', () => {
  it('récupérée, pas partie : retrait + réglage', () => {
    const r = enrichirCourseOperations({ statut: 'IN_DELIVERY', picked_up_at: '2026-10-23T12:29:00.000Z', parti_at: null }, p);
    expect(r.fenetre_ajout_ferme_a).toBe('2026-10-23T12:33:00.000Z');
  });

  it('partie, pas encore récupérée, ou ajout après retrait coupé : rien', () => {
    expect(
      enrichirCourseOperations({ statut: 'IN_DELIVERY', picked_up_at: '2026-10-23T12:29:00.000Z', parti_at: '2026-10-23T12:29:30.000Z' }, p)
        .fenetre_ajout_ferme_a,
    ).toBeNull();
    expect(enrichirCourseOperations({ statut: 'AT_RESTAURANT', picked_up_at: null }, p).fenetre_ajout_ferme_a).toBeNull();
    expect(
      enrichirCourseOperations({ statut: 'IN_DELIVERY', picked_up_at: '2026-10-23T12:29:00.000Z' }, { ...p, fenetreMaxS: 0 })
        .fenetre_ajout_ferme_a,
    ).toBeNull();
  });

  it('liste : seules les commandes avec course changent', () => {
    const sans = { id: 'o1', delivery: null };
    const avec = { id: 'o2', delivery: { id: 'l2', course: { statut: 'PENDING_ASSIGNMENT', offer_attempts: [] } } };
    const [a, b] = enrichirCommandesOperations([sans, avec], p);
    expect(a).toBe(sans);
    expect((b.delivery as any).course).toEqual({
      statut: 'PENDING_ASSIGNMENT',
      offre_en_cours: null,
      fenetre_ajout_ferme_a: null,
      tournee: { total: 0, livrees: 0, fin_prevue: null, en_retard: false, retard_min: null },
    });
  });
});

describe('écran Opérations : fenêtre prolongée tant que la course attend son sac (relecture du 23/10)', () => {
  // Retrait à 12:26, fenêtre jusqu'à 12:30 : il est 12:30:00, elle est échue.
  const RESTO = { latitude: 5.286, longitude: -3.9737 };
  const course = (deliverer: unknown = { last_location: { lat: 5.286, lng: -3.9737 }, last_location_at: '2026-10-23T12:29:40.000Z' }) => ({
    id: 'k',
    statut: 'IN_DELIVERY',
    picked_up_at: '2026-10-23T12:26:00.000Z',
    parti_at: null,
    offer_attempts: [],
    deliverer,
  });
  const liste = (k: ReturnType<typeof course>, ajoutRemis = false) => [
    { id: 'a', status: 'PICKED_UP', restaurant: RESTO, delivery: { course_id: 'k', statut: 'PENDING', ajoutee_apres_retrait: false, course: k } },
    {
      id: 'c',
      status: ajoutRemis ? 'PICKED_UP' : 'READY',
      restaurant: RESTO,
      delivery: { course_id: 'k', statut: 'PENDING', ajoutee_apres_retrait: true, course: k },
    },
  ];
  const fin = (commandes: object[]) =>
    (enrichirCommandesOperations(commandes, { ...p, departRayonM: 250 })[0] as any).delivery.course.fenetre_ajout_ferme_a;

  it('commande ajoutée pas remise, livreur au comptoir (position de 20 s) : fin repoussée de 2 min, comme au serveur', () => {
    expect(coursesQuiAttendentUnSac(liste(course()))).toEqual(new Set(['k']));
    expect(fin(liste(course()))).toBe('2026-10-23T12:32:00.000Z');
  });

  it('sac remis, livreur sans position ou sorti du rayon : fin d’origine (le serveur la marque partie)', () => {
    expect(fin(liste(course(), true))).toBe('2026-10-23T12:30:00.000Z');
    expect(fin(liste(course({ last_location: null, last_location_at: null })))).toBe('2026-10-23T12:30:00.000Z');
    expect(fin(liste(course({ last_location: { lat: 5.29, lng: -3.9737 }, last_location_at: '2026-10-23T12:29:50.000Z' })))).toBe(
      '2026-10-23T12:30:00.000Z',
    );
    // Dernière position de 15 min, au comptoir : téléphone sans la permission « Toujours », appli en
    // arrière-plan ; aucune position hors du rayon depuis le retrait (sinon la course serait partie).
    expect(fin(liste(course({ last_location: { lat: 5.286, lng: -3.9737 }, last_location_at: '2026-10-23T12:14:30.000Z' })))).toBe(
      '2026-10-23T12:32:00.000Z',
    );
    // Immobile au comptoir (position de 3 min, l'appli n'envoie rien à l'arrêt) : il attend son sac (seconde relecture).
    expect(fin(liste(course({ last_location: { lat: 5.286, lng: -3.9737 }, last_location_at: '2026-10-23T12:27:00.000Z' })))).toBe(
      '2026-10-23T12:32:00.000Z',
    );
    // Fenêtre pas encore échue : rien ne change.
    const tot = enrichirCommandesOperations(liste(course()), { maintenant: new Date('2026-10-23T12:29:00.000Z'), fenetreMaxS: 240, departRayonM: 250 });
    expect((tot[0] as any).delivery.course.fenetre_ajout_ferme_a).toBe('2026-10-23T12:30:00.000Z');
  });

  it('relevé imprécis (150 m) à 450 m : la dernière position précise, au comptoir, décide, comme au serveur (relecture du 24/10)', () => {
    const imprecis = {
      last_location: { lat: 5.29, lng: -3.9737, precision_m: 150, sure: { lat: 5.286, lng: -3.9737, at: '2026-10-23T12:27:00.000Z' } },
      last_location_at: '2026-10-23T12:29:50.000Z',
    };
    expect(fin(liste(course(imprecis)))).toBe('2026-10-23T12:32:00.000Z');
    // Aucune position précise connue : rien ne la prolonge.
    expect(fin(liste(course({ ...imprecis, last_location: { lat: 5.286, lng: -3.9737, precision_m: 150, sure: null } })))).toBe(
      '2026-10-23T12:30:00.000Z',
    );
  });

  it('commande d’origine remise une par une au bouton de la caisse, la seconde encore au comptoir : il attend aussi son sac', () => {
    const k = course();
    const origine = [
      { id: 'a', status: 'PICKED_UP', restaurant: RESTO, delivery: { course_id: 'k', statut: 'PENDING', ajoutee_apres_retrait: false, course: k } },
      { id: 'b', status: 'READY', restaurant: RESTO, delivery: { course_id: 'k', statut: 'PENDING', ajoutee_apres_retrait: false, course: k } },
    ];
    expect(coursesQuiAttendentUnSac(origine)).toEqual(new Set(['k']));
    expect(fin(origine)).toBe('2026-10-23T12:32:00.000Z');
    // Les deux remises : plus rien n'attend.
    expect(coursesQuiAttendentUnSac([origine[0], { ...origine[1], status: 'PICKED_UP' }])).toEqual(new Set());
  });
});

// ─── Ajouts du 24/10 (conception, 11.2) ──────────────────────────────────────

describe('écran Opérations : tournée de chaque course (24/10)', () => {
  // Retrait 12:00, parti 12:05 (départ réel), tournée estimée à 15 min : fin vers 12:20.
  const partie = (surcharge: Record<string, unknown> = {}) => ({
    id: 'k',
    statut: 'IN_DELIVERY',
    picked_up_at: '2026-10-23T12:00:00.000Z',
    parti_at: '2026-10-23T12:05:00.000Z',
    motif_depart: 'POSITION',
    estimated_duration_min: 15,
    delay_alerted_at: null,
    offer_attempts: [],
    deliveries: [{ statut: 'DELIVERED' }, { statut: 'IN_ROUTE' }, { statut: 'PENDING' }, { statut: 'CANCELLED' }],
    ...surcharge,
  });

  // 12:15 : 15 min depuis le retrait, sous le seuil (15 × 1,5 = 22,5 min).
  const p15 = { ...p, maintenant: new Date('2026-10-23T12:15:00.000Z') };

  it('« 1 sur 3 livrée » : livraisons annulées hors du total ; fin prévue ; livraisons lues retirées de la réponse', () => {
    const r = enrichirCourseOperations(partie(), p15);
    expect(r.tournee).toEqual({ total: 3, livrees: 1, fin_prevue: '2026-10-23T12:20:00.000Z', en_retard: false, retard_min: null });
    expect('deliveries' in r).toBe(false);
  });

  it('en retard (30 min écoulées depuis le retrait, 15 × 1,5 = 22,5) : « En retard de 10 min »', () => {
    const r = enrichirCourseOperations(partie(), { ...p, maintenant: new Date('2026-10-23T12:30:00.000Z') });
    expect(r.tournee).toMatchObject({ en_retard: true, retard_min: 10 });
  });

  it('facteur du réglage appliqué ; alerte du cron déjà donnée : en retard sans durée tant que la fin prévue n’est pas passée', () => {
    expect(enrichirCourseOperations(partie(), { ...p, maintenant: new Date('2026-10-23T12:30:00.000Z'), facteurRetard: 3 }).tournee.en_retard).toBe(
      false,
    );
    const alertee = enrichirCourseOperations(partie({ delay_alerted_at: '2026-10-23T12:15:00.000Z' }), {
      ...p,
      maintenant: new Date('2026-10-23T12:16:00.000Z'),
    });
    expect(alertee.tournee).toMatchObject({ en_retard: true, retard_min: null });
  });

  it('pas encore parti (fenêtre d’ajout, Turbo) : pas de fin prévue ; le retard compte depuis le retrait, comme le cron', () => {
    expect(enrichirCourseOperations(partie({ parti_at: null, motif_depart: null }), p15).tournee).toMatchObject({
      fin_prevue: null,
      en_retard: false,
    });
    // Toujours pas parti 30 min après le retrait : en retard, sans durée (pas de fin prévue).
    expect(enrichirCourseOperations(partie({ parti_at: null, motif_depart: null }), p).tournee).toMatchObject({
      fin_prevue: null,
      en_retard: true,
      retard_min: null,
    });
  });

  it('course pas récupérée : ni fin prévue ni retard', () => {
    expect(enrichirCourseOperations(partie({ statut: 'AT_RESTAURANT', picked_up_at: null, parti_at: null }), p).tournee).toMatchObject({
      fin_prevue: null,
      en_retard: false,
      retard_min: null,
    });
  });
});

describe('écran Opérations : appli du livreur (24/10)', () => {
  const MAINTENANT_APPLI = new Date('2026-10-23T12:30:00.000Z');
  const course = (deliverer: Record<string, unknown> | null) => ({
    id: 'k',
    statut: 'ACCEPTED',
    offer_attempts: [],
    deliveries: [{ statut: 'PENDING' }],
    deliverer,
  });
  const koffi = (surcharge: Record<string, unknown> = {}) => ({
    id: 'liv-koffi',
    first_name: 'Koffi',
    last_location: null,
    last_location_at: null,
    dernier_signal_at: new Date('2026-10-23T12:24:00.000Z'),
    protocole_appli: 4,
    ...surcharge,
  });
  const appli = (connectes: string[] | null, appliFermeeApresS = 180) => ({
    appliFermeeApresS,
    connectes: connectes ? new Set(connectes) : null,
  });
  const lire = (deliverer: Record<string, unknown> | null, a = appli([])) =>
    enrichirCourseOperations(course(deliverer), { ...p, maintenant: MAINTENANT_APPLI, appli: a }).deliverer as any;

  it('vue il y a 6 min, sans socket : appli fermée, dernier signe de vie ; signe de vie et protocole retirés', () => {
    const d = lire(koffi());
    expect(d).toEqual({
      id: 'liv-koffi',
      first_name: 'Koffi',
      last_location: null,
      last_location_at: null,
      appli_active: false,
      appli_vue_a: '2026-10-23T12:24:00.000Z',
      appli_connectee: false,
    });
  });

  it('signe de vie de 1 min sans socket : en arrière-plan ; socket ouvert : connectée', () => {
    expect(lire(koffi({ dernier_signal_at: '2026-10-23T12:29:00.000Z' }))).toMatchObject({ appli_active: true, appli_connectee: false });
    expect(lire(koffi(), appli(['liv-koffi']))).toMatchObject({ appli_active: true, appli_connectee: true });
  });

  it('ancienne appli (protocole 3) ou règle coupée : état inconnu ; présence inconnue : appli jugée au signe de vie', () => {
    expect(lire(koffi({ protocole_appli: 3 }))).toMatchObject({ appli_active: null, appli_connectee: false });
    expect(lire(koffi({ protocole_appli: null }))).toMatchObject({ appli_active: null });
    expect(lire(koffi(), appli([], 0))).toMatchObject({ appli_active: null });
    expect(lire(koffi(), appli(null))).toMatchObject({ appli_active: false, appli_connectee: null });
  });

  it('jamais vu : appli fermée, aucune heure', () => {
    expect(lire(koffi({ dernier_signal_at: null }))).toMatchObject({ appli_active: false, appli_vue_a: null });
  });

  it('course sans livreur : rien d’ajouté', () => {
    expect(lire(null)).toBeNull();
  });

  it('livreurs de la liste, une fois chacun : la présence est demandée en une seule lecture', () => {
    const k = course(koffi());
    const liste = [
      { id: 'a', delivery: { course: k } },
      { id: 'b', delivery: { course: k } },
      { id: 'c', delivery: { course: course(koffi({ id: 'liv-awa' })) } },
      { id: 'd', delivery: { course: course(null) } },
      { id: 'e', delivery: null },
    ];
    expect(livreursDesCommandes(liste)).toEqual(['liv-koffi', 'liv-awa']);
  });
});

describe('écran Opérations : codes jamais renvoyés (24/10)', () => {
  it('l’enrichissement n’ajoute ni le code du client ni celui de la commande', () => {
    const commande = {
      id: 'o1',
      status: 'PICKED_UP',
      delivery: { id: 'l1', statut: 'IN_ROUTE', course: { id: 'k', statut: 'IN_DELIVERY', pickup_code: '614', offer_attempts: [], deliveries: [] } },
    };
    const [r] = enrichirCommandesOperations([commande], p) as any[];
    expect(r).not.toHaveProperty('recovery_code');
    expect(r.delivery).not.toHaveProperty('delivery_pin');
    // Le code de retrait (dit par le livreur à la caisse) reste : le groupe de la course le montre.
    expect(r.delivery.course.pickup_code).toBe('614');
  });
});

describe('écran Opérations : lecture des réglages', () => {
  it('facteur de retard : défaut 1,5 si vide, illisible ou pas positif', () => {
    expect(lireFacteurRetard(undefined)).toBe(1.5);
    expect(lireFacteurRetard('')).toBe(1.5);
    expect(lireFacteurRetard('abc')).toBe(1.5);
    expect(lireFacteurRetard('0')).toBe(1.5);
    expect(lireFacteurRetard('2')).toBe(2);
  });

  it('seuil de l’appli fermée : défaut 180 si vide ou illisible, 0 coupe la règle', () => {
    expect(lireAppliFermeeApresS(undefined)).toBe(180);
    expect(lireAppliFermeeApresS('x')).toBe(180);
    expect(lireAppliFermeeApresS('0')).toBe(0);
    expect(lireAppliFermeeApresS('300')).toBe(300);
  });
});
