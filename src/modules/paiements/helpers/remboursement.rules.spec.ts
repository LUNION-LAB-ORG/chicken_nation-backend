import { PaiementMode, PaiementStatus, UserRole, UserType } from '@prisma/client';
import {
  MESSAGE_DEJA_REMBOURSE,
  MESSAGE_DEJA_REMBOURSE_KKIAPAY,
  MESSAGE_INCONNUE,
  MESSAGE_PAS_REUSSI,
  bilanRemboursement,
  estPaiementKkiapay,
  estRembourseeChezKkiapay,
  libelleStatutKkiapay,
  messageRefusKkiapay,
  peutRembourser,
} from './remboursement.rules';

const compte = (role: UserRole, restaurant: string | null = null) => ({
  id: 'u',
  role,
  type: restaurant ? UserType.RESTAURANT : UserType.BACKOFFICE,
  restaurant_id: restaurant,
});

describe('remboursement : qui', () => {
  it("l'administrateur rembourse toute commande, même sans commande", () => {
    expect(peutRembourser(compte(UserRole.ADMIN), 'r-1')).toBe(true);
    expect(peutRembourser(compte(UserRole.ADMIN), null)).toBe(true);
  });

  it('le manager, seulement les commandes de son restaurant', () => {
    expect(peutRembourser(compte(UserRole.MANAGER, 'r-1'), 'r-1')).toBe(true);
    expect(peutRembourser(compte(UserRole.MANAGER, 'r-1'), 'r-2')).toBe(false);
    expect(peutRembourser(compte(UserRole.MANAGER, 'r-1'), null)).toBe(false);
    expect(peutRembourser({ ...compte(UserRole.MANAGER, 'r-1'), restaurant_id: null }, 'r-1')).toBe(false);
  });

  it('personne d’autre : assistant, caissier, call center, comptable', () => {
    expect(peutRembourser(compte(UserRole.ASSISTANT_MANAGER, 'r-1'), 'r-1')).toBe(false);
    expect(peutRembourser(compte(UserRole.CAISSIER, 'r-1'), 'r-1')).toBe(false);
    expect(peutRembourser(compte(UserRole.CALL_CENTER), 'r-1')).toBe(false);
    expect(peutRembourser(compte(UserRole.COMPTABLE), 'r-1')).toBe(false);
  });

  it('un administrateur rattaché par erreur à un restaurant ne rembourse pas tout le réseau', () => {
    expect(peutRembourser({ ...compte(UserRole.ADMIN), type: UserType.RESTAURANT, restaurant_id: 'r-1' }, 'r-2')).toBe(false);
  });
});

describe('remboursement : quel paiement', () => {
  it('seulement un paiement passé par KKiaPay', () => {
    expect(estPaiementKkiapay({ reference: '459100796371', mode: PaiementMode.WALLET })).toBe(true);
    expect(estPaiementKkiapay({ reference: 'PAY-1762900000000-123', mode: PaiementMode.MOBILE_MONEY })).toBe(false);
    expect(estPaiementKkiapay({ reference: '459100796371', mode: PaiementMode.CASH })).toBe(false);
    expect(estPaiementKkiapay({ reference: '  ', mode: PaiementMode.WALLET })).toBe(false);
  });

  it('reconnaît une transaction remboursée chez KKiaPay, quel que soit le mot', () => {
    expect(estRembourseeChezKkiapay({ status: 'REVERTED' })).toBe(true);
    expect(estRembourseeChezKkiapay({ status: 'refunded' })).toBe(true);
    expect(estRembourseeChezKkiapay({ status: 'SUCCESS' })).toBe(false);
    expect(estRembourseeChezKkiapay(null)).toBe(false);
    expect(libelleStatutKkiapay({ status: 'success' })).toBe('Payée');
    expect(libelleStatutKkiapay({ status: 'REVERTED' })).toBe('Remboursée');
    expect(libelleStatutKkiapay({ status: 'BIZARRE' })).toBe('BIZARRE');
  });
});

describe('remboursement : bilan de la vérification', () => {
  const paiement = { status: PaiementStatus.SUCCESS, amount: 6060, total: 6176, rembourse_at: null };

  it('payée chez KKiaPay, même montant : remboursable', () => {
    expect(bilanRemboursement(paiement, { status: 'SUCCESS', amount: 6060 })).toEqual({ remboursable: true, constatable: false, raison: null });
    // Le montant KKiaPay peut être celui du total, frais compris.
    expect(bilanRemboursement(paiement, { status: 'SUCCESS', amount: 6176 }).remboursable).toBe(true);
    // Écart d'arrondi toléré.
    expect(bilanRemboursement(paiement, { status: 'SUCCESS', amount: 6100 }).remboursable).toBe(true);
  });

  it('montant différent : bloqué par prudence', () => {
    const b = bilanRemboursement(paiement, { status: 'SUCCESS', amount: 9000 });
    expect(b.remboursable).toBe(false);
    expect(b.raison).toContain('9 000 F');
    expect(b.raison).toContain('6 060 F');
    expect(bilanRemboursement(paiement, { status: 'SUCCESS', amount: 'abc' }).remboursable).toBe(false);
  });

  it('transaction inconnue, échouée, ou déjà remboursée chez KKiaPay', () => {
    expect(bilanRemboursement(paiement, null)).toEqual({ remboursable: false, constatable: false, raison: MESSAGE_INCONNUE });
    const echouee = bilanRemboursement(paiement, { status: 'FAILED', amount: 6060 });
    expect(echouee.remboursable).toBe(false);
    expect(echouee.raison).toContain('échouée');
    expect(bilanRemboursement(paiement, { status: 'REVERTED', amount: 6060 })).toEqual({
      remboursable: false,
      constatable: true,
      raison: MESSAGE_DEJA_REMBOURSE_KKIAPAY,
    });
  });

  it('paiement déjà remboursé ou pas réussi chez nous', () => {
    expect(bilanRemboursement({ ...paiement, status: PaiementStatus.REVERTED }, { status: 'SUCCESS', amount: 6060 }).raison).toBe(MESSAGE_DEJA_REMBOURSE);
    expect(bilanRemboursement({ ...paiement, rembourse_at: new Date() }, { status: 'SUCCESS', amount: 6060 }).raison).toBe(MESSAGE_DEJA_REMBOURSE);
    expect(bilanRemboursement({ ...paiement, status: PaiementStatus.PENDING }, { status: 'SUCCESS', amount: 6060 }).raison).toBe(MESSAGE_PAS_REUSSI);
  });
});

describe('remboursement : refus de KKiaPay', () => {
  it('traduit ses codes', () => {
    expect(messageRefusKkiapay('TRANSACTION_NOT_ELIGIBLE', null)).toContain('déjà remboursée ou ne peut pas l’être');
    expect(messageRefusKkiapay('TRANSACTION_NOT_FOUND', null)).toContain('ne trouve pas');
    expect(messageRefusKkiapay('INVALID_TRANSACTION', null)).toContain("n'appartient pas");
    expect(messageRefusKkiapay(null, 'Solde marchand insuffisant')).toBe('KKiaPay refuse le remboursement : Solde marchand insuffisant');
    expect(messageRefusKkiapay(null, null)).toBe('KKiaPay refuse le remboursement.');
  });
});
