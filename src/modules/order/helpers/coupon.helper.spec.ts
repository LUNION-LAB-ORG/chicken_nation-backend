import { DiscountType, TargetType, VoucherStatus } from '@prisma/client';
import { texteMouvementBon } from 'src/modules/voucher/helpers/mouvement-bon.texte';
import {
  arrondirRemise,
  assietteDesRemises,
  libelleCodePromo,
  masquerCode,
  motifRefusBon,
  normaliserCode,
  reformulerRefusCodePromo,
} from './coupon.helper';

/** Espaces de mise en forme des nombres français, remplacés pour comparer. */
const plat = (texte: string) => texte.replace(/[  ]/g, ' ');

describe('Réduction : fonctions pures', () => {
  it('normalise le code : majuscules, sans espaces autour', () => {
    expect(normaliserCode('  bienvenue20 ')).toBe('BIENVENUE20');
    expect(normaliserCode(undefined)).toBe('');
    expect(normaliserCode('   ')).toBe('');
  });

  describe('arrondi de la remise au franc', () => {
    it('arrondit au plus proche', () => {
      expect(arrondirRemise(1670.5, 10_000)).toBe(1671);
      expect(arrondirRemise(1670.4, 10_000)).toBe(1670);
    });

    it('ne dépasse jamais le plafond (solde du bon à virgule)', () => {
      // 1 500,6 arrondi donnerait 1 501, plus que le solde : on descend.
      expect(arrondirRemise(8000, 1500.6)).toBe(1500);
    });

    it('plafonne au montant des articles et ne devient jamais négative', () => {
      expect(arrondirRemise(12_000, 8000)).toBe(8000);
      expect(arrondirRemise(-5, 8000)).toBe(0);
    });
  });

  it("masque le code d'un bon : 4 caractères sur 6 restent inconnus", () => {
    expect(masquerCode('CN7K2XQ9')).toBe('CN••••Q9');
    expect(masquerCode('CNR-1727000000000-123')).toBe('CN••••••23');
    expect(masquerCode('AB')).toBe('••••');
  });

  it("construit l'assiette des remises : plat plus options, sans suppléments", () => {
    expect(
      assietteDesRemises([{ dish_id: 'd1', quantity: 2, dishPrice: 3000, optionsUnitPrice: 500 }]),
    ).toEqual([{ dish_id: 'd1', quantity: 2, price: 3500 }]);
  });

  it('écrit un libellé lisible pour chaque type de code', () => {
    expect(
      plat(
        libelleCodePromo({
          discount_type: DiscountType.PERCENTAGE,
          discount_value: 20,
          max_discount_amount: 2000,
          target_type: TargetType.ALL_PRODUCTS,
        }),
      ),
    ).toBe('20 % sur la commande, dans la limite de 2 000 F');
    expect(
      plat(
        libelleCodePromo({
          discount_type: DiscountType.FIXED_AMOUNT,
          discount_value: 1500,
          target_type: TargetType.SPECIFIC_PRODUCTS,
        }),
      ),
    ).toBe('remise de 1 500 F sur les articles concernés');
  });

  describe('motif de refus d’un bon', () => {
    const maintenant = new Date('2026-09-25T12:00:00Z');
    const bon = (s: Partial<{ status: VoucherStatus; expires_at: Date | null; remaining_amount: number }>) => ({
      status: VoucherStatus.ACTIVE,
      expires_at: null,
      remaining_amount: 10_000,
      ...s,
    });

    it('accepte un bon actif, garni, sans échéance dépassée', () => {
      expect(motifRefusBon(bon({}), maintenant)).toBeNull();
    });
    it('refuse un bon épuisé', () => {
      expect(motifRefusBon(bon({ status: VoucherStatus.REDEEMED, remaining_amount: 0 }), maintenant)).toBe(
        'Ce bon est épuisé.',
      );
      expect(motifRefusBon(bon({ remaining_amount: 0.4 }), maintenant)).toBe('Ce bon est épuisé.');
    });
    it('refuse un bon expiré, même encore marqué actif', () => {
      expect(motifRefusBon(bon({ expires_at: new Date('2026-09-24T12:00:00Z') }), maintenant)).toBe(
        'Ce bon a expiré.',
      );
      expect(motifRefusBon(bon({ status: VoucherStatus.EXPIRED }), maintenant)).toBe('Ce bon a expiré.');
    });
    it('refuse un bon annulé', () => {
      expect(motifRefusBon(bon({ status: VoucherStatus.CANCELLED }), maintenant)).toBe('Ce bon a été annulé.');
    });
  });

  describe("reformulation des refus du moteur (écrits pour l'app)", () => {
    it("parle du client, pas à l'agent", () => {
      expect(reformulerRefusCodePromo('Vous avez déjà utilisé ce code promo le nombre maximum de fois')).toBe(
        'Ce client a déjà utilisé ce code promo le nombre maximum de fois.',
      );
    });
    it('met en forme le minimum de commande', () => {
      expect(plat(reformulerRefusCodePromo('Le montant minimum de commande est de 5000 FCFA'))).toBe(
        'Le montant minimum de commande pour ce code est de 5 000 F, hors livraison.',
      );
    });
    it('garde les autres messages, avec un point final', () => {
      expect(reformulerRefusCodePromo('Ce code promo a expiré')).toBe('Ce code promo a expiré.');
    });
  });

  describe('notification au client', () => {
    it('usage : montant, solde et consigne en cas de fraude', () => {
      const { titre, message } = texteMouvementBon({
        sens: 'DEBIT',
        code: 'CN7K2XQ9',
        montant: 8000,
        solde: 2000,
        reference: 'CMD-42',
      });
      expect(titre).toBe("Bon d'achat utilisé");
      expect(plat(message)).toBe(
        'Votre bon CN7K2XQ9 a servi pour la commande CMD-42 : réduction de 8 000 F CFA. Solde restant : 2 000 F CFA.' +
          " Si vous n'êtes pas à l'origine de cette commande, contactez-nous.",
      );
    });

    it('usage qui vide le bon', () => {
      const { message } = texteMouvementBon({ sens: 'DEBIT', code: 'CN1', montant: 500, solde: 0 });
      expect(message).toContain('Il est désormais entièrement utilisé.');
      expect(message).toContain('pour une commande');
    });

    it('restitution après suppression, bon prolongé', () => {
      const { titre, message } = texteMouvementBon({
        sens: 'CREDIT',
        code: 'CN7K2XQ9',
        montant: 8000,
        solde: 10_000,
        reference: 'CMD-42',
        motif: 'SUPPRESSION',
        valableJusquau: new Date('2026-10-25T12:00:00Z'),
      });
      expect(titre).toBe("Bon d'achat recrédité");
      expect(plat(message)).toBe(
        'La commande CMD-42 a été supprimée : votre bon CN7K2XQ9 est recrédité de 8 000 F CFA.' +
          " Solde disponible : 10 000 F CFA. Il est valable jusqu'au 25/10/2026.",
      );
    });

    it("aucun tiret long ni « N/A » dans les textes visibles", () => {
      const textes = [
        texteMouvementBon({ sens: 'DEBIT', code: 'X', montant: 1, solde: 0 }).message,
        texteMouvementBon({ sens: 'CREDIT', code: 'X', montant: 1, solde: 1, motif: 'ANNULATION' }).message,
        libelleCodePromo({
          discount_type: DiscountType.PERCENTAGE,
          discount_value: 12.5,
          target_type: TargetType.CATEGORIES,
        }),
      ];
      for (const t of textes) {
        expect(t).not.toMatch(/[\u2013\u2014]/);
        expect(t).not.toContain('N/A');
      }
    });
  });
});
