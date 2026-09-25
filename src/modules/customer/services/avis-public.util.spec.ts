import {
  AVIS_PUBLIC_SELECT,
  AVIS_PUBLICS_LIMITE_MAX,
  initialeDuNom,
  limiteAvisPublics,
  versAvisPublic,
} from './avis-public.util';

const date = new Date('2026-09-01T10:00:00Z');

describe('versAvisPublic', () => {
  it('ne garde que note, texte, date, prénom et initiale du nom', () => {
    const avisLu = {
      id: 'a1',
      message: 'Très bon poulet',
      rating: 5,
      created_at: date,
      // Champs qu'une requête trop large aurait pu charger : aucun ne doit sortir.
      site_visible: true,
      customer_id: 'c1',
      order_id: 'o1',
      customer: {
        id: 'c1',
        first_name: ' Awa ',
        last_name: 'koné',
        phone: '+2250700000000',
        email: 'awa@exemple.ci',
        image: 'photo.jpg',
      },
      order: { id: 'o1', reference: 'CN-0001', created_at: date },
    };

    const avis = versAvisPublic(avisLu);

    expect(avis).toEqual({
      id: 'a1',
      message: 'Très bon poulet',
      rating: 5,
      created_at: date,
      customer: { first_name: 'Awa', last_name: 'K' },
    });
    const texte = JSON.stringify(avis);
    for (const interdit of ['+2250700000000', 'awa@exemple.ci', 'photo.jpg', 'CN-0001', 'c1', 'o1', 'koné']) {
      expect(texte).not.toContain(interdit);
    }
  });

  it('client absent ou sans nom : champs à null, jamais une erreur', () => {
    const sansClient = versAvisPublic({ id: 'a2', message: '', rating: 4, created_at: date, customer: null });
    expect(sansClient.customer).toEqual({ first_name: null, last_name: null });

    const sansNom = versAvisPublic({
      id: 'a3',
      message: 'Bien',
      rating: 3,
      created_at: date,
      customer: { first_name: '  ', last_name: null },
    });
    expect(sansNom.customer).toEqual({ first_name: null, last_name: null });
  });
});

describe('initialeDuNom', () => {
  it("renvoie l'initiale en majuscule, ou null", () => {
    expect(initialeDuNom('Koné')).toBe('K');
    expect(initialeDuNom('  ouattara')).toBe('O');
    expect(initialeDuNom('')).toBeNull();
    expect(initialeDuNom(null)).toBeNull();
    expect(initialeDuNom(undefined)).toBeNull();
  });
});

describe('limiteAvisPublics', () => {
  it('borne la taille de page publique', () => {
    expect(limiteAvisPublics(12)).toBe(12);
    expect(limiteAvisPublics(100000)).toBe(AVIS_PUBLICS_LIMITE_MAX);
    expect(limiteAvisPublics(0)).toBe(10);
    expect(limiteAvisPublics(-5)).toBe(10);
    expect(limiteAvisPublics(undefined)).toBe(10);
    expect(limiteAvisPublics(Number.NaN)).toBe(10);
  });
});

describe('AVIS_PUBLIC_SELECT', () => {
  it('ne lit en base ni téléphone, ni e-mail, ni photo, ni commande', () => {
    expect(AVIS_PUBLIC_SELECT).toEqual({
      id: true,
      message: true,
      rating: true,
      created_at: true,
      customer: { select: { first_name: true, last_name: true } },
    });
  });
});
