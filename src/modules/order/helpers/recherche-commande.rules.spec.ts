/**
 * Recherche d'une commande par le nom ou le numéro du client, la référence,
 * et quelques autres repères (27/11). Règles : recherche-commande.rules.ts.
 */
import {
  LETTRES_ACCENTUEES,
  LETTRES_NUES,
  conditionRecherche,
  lireRecherche,
  motifsDuNom,
  motsDeRecherche,
  numeroCherche,
} from './recherche-commande.rules';

const texte = (condition: unknown) => JSON.stringify(condition);

describe('lireRecherche', () => {
  it('resserre la saisie et retire le « # » de tête', () => {
    expect(lireRecherche('  Awa   Koné ')).toBe('Awa Koné');
    expect(lireRecherche('#ORD-261127-12345')).toBe('ORD-261127-12345');
  });

  it("ne filtre rien en dessous de deux caractères ou sans texte", () => {
    expect(lireRecherche('a')).toBeNull();
    expect(lireRecherche('   ')).toBeNull();
    expect(lireRecherche(undefined)).toBeNull();
    expect(lireRecherche(42)).toBeNull();
  });

  it('coupe une saisie trop longue', () => {
    expect(lireRecherche('x'.repeat(300))).toHaveLength(80);
  });
});

describe('numeroCherche', () => {
  it('lit un numéro écrit de plusieurs façons', () => {
    expect(numeroCherche('0707070707')).toBe('0707070707');
    expect(numeroCherche('07 07 07 07 07')).toBe('0707070707');
    expect(numeroCherche('07.07.07.07.07')).toBe('0707070707');
  });

  it("ramène un numéro complet avec indicatif à ses dix chiffres", () => {
    expect(numeroCherche('+225 07 07 07 07 07')).toBe('0707070707');
    expect(numeroCherche('002250707070707')).toBe('0707070707');
    expect(numeroCherche('2250707070707')).toBe('0707070707');
  });

  it('accepte une partie de numéro, à partir de quatre chiffres', () => {
    expect(numeroCherche('7070')).toBe('7070');
    expect(numeroCherche('707')).toBeNull();
  });

  it("n'est pas un numéro dès qu'il y a une lettre", () => {
    expect(numeroCherche('ORD-261127-12345')).toBeNull();
    expect(numeroCherche('Awa 0707')).toBeNull();
  });
});

describe('motsDeRecherche', () => {
  it('découpe un nom, quatre mots au plus', () => {
    expect(motsDeRecherche('Awa Koné')).toEqual(['Awa', 'Koné']);
    expect(motsDeRecherche('a b c d e f')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('aucun mot quand la saisie est un numéro', () => {
    expect(motsDeRecherche('07 07 07 07 07')).toEqual([]);
  });
});

describe('conditionRecherche', () => {
  it('cherche toujours dans la référence', () => {
    const condition = conditionRecherche('ORD-261127');
    expect(condition.OR?.[0]).toEqual({ reference: { contains: 'ORD-261127', mode: 'insensitive' } });
  });

  it('un nom : compte du client, nom inscrit sur la commande, note', () => {
    const condition = texte(conditionRecherche('Awa Koné'));
    expect(condition).toContain('"first_name":{"contains":"Awa"');
    expect(condition).toContain('"last_name":{"contains":"Koné"');
    expect(condition).toContain('"fullname":{"contains":"Awa"');
    expect(condition).toContain('"note":{"contains":"Koné"');
    // Saisi avec l'accent, trouvé aussi sans.
    expect(condition).toContain('"fullname":{"contains":"Kone"');
    // Un nom n'est pas un numéro.
    expect(condition).not.toContain('"phone"');
  });

  it('tous les mots doivent se retrouver', () => {
    const condition = conditionRecherche('Awa Koné');
    const surLaCommande = condition.OR?.find((c) => texte(c).startsWith('{"AND":[{"OR":[{"fullname"'));
    expect((surLaCommande as { AND: unknown[] }).AND).toHaveLength(2);
  });

  it('un numéro : compte du client, commande, note sous ses deux écritures', () => {
    const condition = conditionRecherche('+225 07 07 07 07 07');
    expect(condition.OR).toEqual(
      expect.arrayContaining([
        { phone: { contains: '0707070707' } },
        { customer: { phone: { contains: '0707070707' } } },
        { note: { contains: '0707070707' } },
        { note: { contains: '07 07 07 07 07' } },
      ]),
    );
    expect(texte(condition)).not.toContain('first_name');
  });

  it('une partie de numéro cherche aussi dans la référence', () => {
    const condition = conditionRecherche('12345');
    expect(condition.OR).toEqual(
      expect.arrayContaining([
        { reference: { contains: '12345', mode: 'insensitive' } },
        { customer: { phone: { contains: '12345' } } },
      ]),
    );
  });

  it("une adresse électronique n'est cherchée que si la saisie contient « @ »", () => {
    expect(texte(conditionRecherche('awa@exemple.ci'))).toContain('"email":{"contains":"awa@exemple.ci"');
    expect(texte(conditionRecherche('awa'))).not.toContain('"email"');
  });

  it('code promo et référence de paiement : en entier, pour une saisie sans espace', () => {
    const condition = conditionRecherche('NOEL25');
    expect(condition.OR).toEqual(
      expect.arrayContaining([
        { code_promo: { equals: 'NOEL25', mode: 'insensitive' } },
        { paiements: { some: { reference: { equals: 'NOEL25', mode: 'insensitive' } } } },
      ]),
    );
    expect(texte(conditionRecherche('Awa Koné'))).not.toContain('code_promo');
  });

  it('clients lus à part, accents ignorés : la commande est cherchée par leur identifiant', () => {
    const condition = conditionRecherche('Kone', { clientsAuNom: ['c1', 'c2'] });
    expect(condition.OR).toEqual(expect.arrayContaining([{ customer_id: { in: ['c1', 'c2'] } }]));
    expect(texte(condition)).not.toContain('first_name');
    // Aucun client à ce nom : la branche disparaît, le nom inscrit sur la commande reste cherché.
    const sansClient = conditionRecherche('Kone', { clientsAuNom: [] });
    expect(texte(sansClient)).not.toContain('customer_id');
    expect(texte(sansClient)).toContain('"fullname":{"contains":"Kone"');
  });

  describe('rôle aux coordonnées masquées', () => {
    it('ne cherche ni par numéro ni par adresse électronique', () => {
      const numero = texte(conditionRecherche('0707070707', { sansCoordonnees: true }));
      expect(numero).not.toContain('phone');
      expect(numero).not.toContain('note');
      expect(numero).toContain('"reference"');
      expect(texte(conditionRecherche('awa@exemple.ci', { sansCoordonnees: true }))).not.toContain('email');
    });

    it('cherche par nom, sans lire la note (elle peut porter un numéro)', () => {
      const nom = texte(conditionRecherche('Awa', { sansCoordonnees: true }));
      expect(nom).toContain('first_name');
      expect(nom).toContain('fullname');
      expect(nom).not.toContain('note');
    });
  });
});

describe('motifsDuNom', () => {
  it('minuscules, sans accents, jokers neutralisés', () => {
    expect(motifsDuNom(['Koné', 'AWA'])).toEqual(['%kone%', '%awa%']);
    expect(motifsDuNom(['50%_a'])).toEqual(['%50\\%\\_a%']);
  });

  it('les deux listes de lettres se répondent une à une', () => {
    expect(LETTRES_ACCENTUEES).toHaveLength(LETTRES_NUES.length);
  });
});
