import { codesPossibles, lireCodeChoisi, lireSaisie } from './referral-code.rules';

const premiers = (client: Parameters<typeof codesPossibles>[0], n: number) => {
  const codes: string[] = [];
  for (const c of codesPossibles(client)) {
    codes.push(c);
    if (codes.length === n) break;
  }
  return codes;
};

describe('Codes de parrainage CN-PRENOM', () => {
  it('prénom, nom, puis prénom numéroté', () => {
    expect(premiers({ first_name: 'Awa', last_name: 'Koné' }, 4)).toEqual([
      'CN-AWA',
      'CN-KONE',
      'CN-AWA2',
      'CN-AWA3',
    ]);
  });

  it('premier mot seulement, sans accents ni ponctuation', () => {
    expect(premiers({ first_name: 'Marie-Hélène Ange', last_name: "N'Guessan" }, 2)).toEqual([
      'CN-MARIEHELENE',
      'CN-NGUESSAN',
    ]);
  });

  it('sans prénom → le nom ; sans nom → CN-CLIENT, jamais le téléphone', () => {
    expect(premiers({ last_name: 'Traoré' }, 2)).toEqual(['CN-TRAORE', 'CN-TRAORE2']);
    expect(premiers({}, 2)).toEqual(['CN-CLIENT', 'CN-CLIENT2']);
  });

  it('jamais la forme d’un numéro de carte (CN-BA123)', () => {
    const codes = premiers({ first_name: 'Ba' }, 150);
    expect(codes).not.toContain('CN-BA100');
    expect(codes.filter((c) => /^CN-[A-Z]{2}\d{3}$/.test(c))).toEqual([]);
  });

  it('saisie du client : tiret, espaces, minuscules et préfixe facultatifs', () => {
    expect(lireSaisie('cn-awa').nouveaux).toContain('CN-AWA');
    expect(lireSaisie('CN AWA').nouveaux).toContain('CN-AWA');
    expect(lireSaisie('CNAWA').nouveaux).toContain('CN-AWA');
    expect(lireSaisie('awa').nouveaux).toEqual(['CN-AWA']);
    expect(lireSaisie('cnabc23').ancien).toBe('CNABC23');
    expect(lireSaisie('  ').ancien).toBe('');
  });

  it('code choisi au backoffice', () => {
    expect(lireCodeChoisi('awa')).toEqual({ code: 'CN-AWA' });
    expect(lireCodeChoisi('CN-Awa 2')).toEqual({ code: 'CN-AWA2' });
    expect(lireCodeChoisi('CN-A')).toHaveProperty('erreur');
    expect(lireCodeChoisi('CN-2024')).toHaveProperty('erreur');
    expect(lireCodeChoisi('CN-BA123')).toHaveProperty('erreur');
    expect(lireCodeChoisi('CN-' + 'A'.repeat(17))).toHaveProperty('erreur');
  });
});
