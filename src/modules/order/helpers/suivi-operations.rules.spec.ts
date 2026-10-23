import { enrichirCommandesOperations, enrichirCourseOperations } from './suivi-operations.rules';

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
