import {
  lireTransactionKkiapay,
  messageRefusConfirmation,
  refusTransactionDejaRattachee,
} from './confirmation-paiement.rules';

describe('Confirmation manuelle d’un paiement KKiaPay : règles (14/11)', () => {
  it('identifiant de transaction : lettres, chiffres, « - _ . », 64 caractères au plus, bords nettoyés', () => {
    expect(lireTransactionKkiapay('  qXw9_Ab-12.3 ')).toBe('qXw9_Ab-12.3');
    expect(lireTransactionKkiapay('123456789')).toBe('123456789');
    expect(lireTransactionKkiapay(`T${'x'.repeat(63)}`)).toHaveLength(64);
    for (const illisible of [undefined, null, 42, '', '   ', 'TX 1', '-TX1', 'TX;1', `T${'x'.repeat(64)}`]) {
      expect({ illisible, lu: lireTransactionKkiapay(illisible) }).toEqual({ illisible, lu: null });
    }
  });

  it('motif du chemin du webhook : refus en clair, motif inconnu rendu tel quel', () => {
    expect(messageRefusConfirmation('commande introuvable')).toBe('Commande introuvable.');
    expect(messageRefusConfirmation('erreur de traitement du paiement')).toBe(
      "Le paiement n'a pas pu être enregistré : réessayez dans un instant.",
    );
    expect(messageRefusConfirmation('motif nouveau')).toBe('motif nouveau');
    expect(messageRefusConfirmation(undefined)).toBe('Confirmation du paiement impossible.');
    expect(messageRefusConfirmation('  ')).toBe('Confirmation du paiement impossible.');
  });

  it('transaction libre, ou déjà rattachée à cette commande : aucun refus', () => {
    expect(refusTransactionDejaRattachee('o-1', [])).toBeNull();
    expect(
      refusTransactionDejaRattachee('o-1', [
        { order_id: 'o-2', order: { reference: 'ORD-2' } },
        { order_id: 'o-1', order: { reference: 'ORD-1' } },
      ]),
    ).toBeNull();
  });

  it('transaction rattachée ailleurs : refus qui cite la commande quand elle est connue', () => {
    expect(refusTransactionDejaRattachee('o-1', [{ order_id: 'o-2', order: { reference: 'ORD-2' } }])).toBe(
      'Cette transaction KKiaPay paie déjà la commande ORD-2.',
    );
    expect(refusTransactionDejaRattachee('o-1', [{ order_id: 'o-2', order: null }])).toBe(
      'Cette transaction KKiaPay paie déjà une autre commande.',
    );
    expect(refusTransactionDejaRattachee('o-1', [{ order_id: null }])).toBe(
      'Cette transaction KKiaPay est déjà enregistrée sans commande : voyez avec un administrateur.',
    );
  });
});
