import { NOTE_COMMANDE_MAX, noteDeCommande } from './note-commande.rules';

/**
 * Note d'une commande de l'appli (26/11) : le client qui commande pour une
 * autre personne y fait écrire son nom et son numéro.
 */
describe('note d\'une commande', () => {
  it('garde le texte, espaces resserrés', () => {
    expect(noteDeCommande('  Commande pour Awa Koné,   07 07 07 07 07 ')).toBe('Commande pour Awa Koné, 07 07 07 07 07');
    expect(noteDeCommande('Sans piment\nmerci')).toBe('Sans piment merci');
  });

  it('rien quand elle est vide ou absente', () => {
    expect(noteDeCommande('')).toBeUndefined();
    expect(noteDeCommande('   ')).toBeUndefined();
    expect(noteDeCommande(undefined)).toBeUndefined();
    expect(noteDeCommande(null)).toBeUndefined();
    expect(noteDeCommande(42)).toBeUndefined();
  });

  it('coupée à 255 caractères', () => {
    const longue = 'a'.repeat(300);
    expect(noteDeCommande(longue)).toHaveLength(NOTE_COMMANDE_MAX);
    expect(noteDeCommande(`${'a'.repeat(254)} b`)).toBe('a'.repeat(254));
  });
});
