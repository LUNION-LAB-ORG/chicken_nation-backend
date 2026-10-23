import { coursesQuiAttendentUnSac, enrichirCommandesOperations, enrichirCourseOperations } from './suivi-operations.rules';

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
    expect((b.delivery as any).course).toEqual({ statut: 'PENDING_ASSIGNMENT', offre_en_cours: null, fenetre_ajout_ferme_a: null });
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

  it('sac remis, livreur sans position fraîche ou sorti du rayon : fin d’origine (le serveur la marque partie)', () => {
    expect(fin(liste(course(), true))).toBe('2026-10-23T12:30:00.000Z');
    expect(fin(liste(course({ last_location: { lat: 5.286, lng: -3.9737 }, last_location_at: '2026-10-23T12:28:30.000Z' })))).toBe(
      '2026-10-23T12:30:00.000Z',
    );
    expect(fin(liste(course({ last_location: { lat: 5.29, lng: -3.9737 }, last_location_at: '2026-10-23T12:29:50.000Z' })))).toBe(
      '2026-10-23T12:30:00.000Z',
    );
    // Fenêtre pas encore échue : rien ne change.
    const tot = enrichirCommandesOperations(liste(course()), { maintenant: new Date('2026-10-23T12:29:00.000Z'), fenetreMaxS: 240, departRayonM: 250 });
    expect((tot[0] as any).delivery.course.fenetre_ajout_ferme_a).toBe('2026-10-23T12:30:00.000Z');
  });
});
