import { PaiementStatus } from '@prisma/client';
import { CodeAlerte } from 'src/modules/alertes/alertes.service';
import { anomaliePaiement, TOLERANCE_IMPAYE } from './impaye.rules';

const reussi = (montant: number) => ({ status: PaiementStatus.SUCCESS, amount: montant });

describe('anomaliePaiement', () => {
  /**
   * La première fausse alerte en production : une commande manuelle réglée au
   * restaurant est marquée payée sans qu'une ligne de paiement existe. Crier
   * « aucun paiement » pendant que tous les écrans affichent « Payé » apprend
   * à ignorer le canal.
   */
  it('se tait dès que la commande est marquée payée, même sans ligne de paiement', () => {
    expect(anomaliePaiement({ amount: 12000, paied: true, paiements: [] })).toBeNull();
  });

  it('signale une commande sans aucun paiement', () => {
    const a = anomaliePaiement({ amount: 12000, paied: false, paiements: [] });
    expect(a?.code).toBe(CodeAlerte.COMMANDE_SANS_PAIEMENT);
    expect(a?.encaisse).toBe(0);
  });

  it('ne compte que les paiements réussis', () => {
    const a = anomaliePaiement({
      amount: 12000,
      paied: false,
      paiements: [{ status: PaiementStatus.FAILED, amount: 12000 }],
    });
    expect(a?.code).toBe(CodeAlerte.COMMANDE_SANS_PAIEMENT);
  });

  it('signale un paiement partiel, et dit ce qui reste', () => {
    const a = anomaliePaiement({ amount: 12000, paied: false, paiements: [reussi(5000)] });
    expect(a?.code).toBe(CodeAlerte.PAIEMENT_PARTIEL);
    expect(a?.details.join(' ')).toContain('7000');
  });

  /** Un arrondi de taxe entre l'application et le serveur n'est pas un impayé. */
  it('tolère un écart d’arrondi', () => {
    expect(anomaliePaiement({ amount: 12000, paied: false, paiements: [reussi(12000 - TOLERANCE_IMPAYE)] })).toBeNull();
    expect(anomaliePaiement({ amount: 12000, paied: false, paiements: [reussi(12000 - TOLERANCE_IMPAYE - 1)] })?.code)
      .toBe(CodeAlerte.PAIEMENT_PARTIEL);
  });

  it('se tait sur un montant nul ou absurde', () => {
    expect(anomaliePaiement({ amount: 0, paied: false, paiements: [] })).toBeNull();
    expect(anomaliePaiement({ amount: -5, paied: false, paiements: [] })).toBeNull();
  });

  it('préfère `total` à `amount` quand il existe', () => {
    expect(anomaliePaiement({
      amount: 12000, paied: false,
      paiements: [{ status: PaiementStatus.SUCCESS, amount: 1, total: 12000 }],
    })).toBeNull();
  });
});
