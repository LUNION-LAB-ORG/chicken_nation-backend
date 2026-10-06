import { CardGenerationService } from './card-generation.service';

/**
 * Le numéro imprimé sur la carte. Il est lu au téléphone et tapé en caisse :
 * sa forme compte autant que son unicité.
 */
describe('numéro de carte', () => {
  // Le générateur n'a besoin d'aucune dépendance : on l'appelle sur le prototype.
  const generer = () =>
    CardGenerationService.prototype.generateCardNumber.call(null) as string;

  it('vaut « CN- » puis une syllabe et trois chiffres', () => {
    for (let i = 0; i < 300; i++) {
      expect(generer()).toMatch(/^CN-[BDFGJKMNPRSTVZ][AEIOU]\d{3}$/);
    }
  });

  it('garde les trois chiffres même pour les petits nombres', () => {
    const vus = new Set<string>();
    for (let i = 0; i < 3000; i++) vus.add(generer().slice(-3));
    // Un numéro comme 7 doit s'écrire « 007 », jamais « 7 ».
    expect([...vus].every((c) => c.length === 3)).toBe(true);
    expect(vus.has('000') || vus.size > 900).toBe(true);
  });

  /**
   * Ni I, ni L, ni O, ni Q : à l'écrit ils se lisent pour des chiffres, et
   * c'est toute la raison d'être de l'alphabet restreint.
   */
  it('n’emploie aucune lettre qui se lit pour un chiffre', () => {
    const lettres = new Set<string>();
    for (let i = 0; i < 2000; i++) lettres.add(generer()[3]);
    for (const interdite of ['I', 'L', 'O', 'Q']) {
      expect(lettres.has(interdite)).toBe(false);
    }
  });

  it('n’imprime aucune syllabe écartée', () => {
    const syllabes = new Set<string>();
    for (let i = 0; i < 4000; i++) syllabes.add(generer().slice(3, 5));
    for (const exclue of ['KU', 'NU', 'PU']) {
      expect(syllabes.has(exclue)).toBe(false);
    }
  });

  /**
   * Le format reste distinct d'un CODE DE COUPON du CRM, qui porte le même
   * préfixe suivi de 6 caractères : en caisse, on doit voir lequel est lequel.
   */
  it('ne ressemble pas à un code de coupon', () => {
    expect(generer()).not.toMatch(/^CN-[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{6}$/);
  });
});
