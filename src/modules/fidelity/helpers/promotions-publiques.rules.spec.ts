/**
 * Promotions affichées aux visiteurs du site (« Offres du moment »).
 */
import { PromotionStatus, Visibility } from '@prisma/client';
import {
  CHAMPS_PROMOTION_PUBLIQUE,
  LIMITE_MAX_PROMOTIONS_PUBLIQUES,
  LIMITE_PROMOTIONS_PUBLIQUES,
  limitePromotionsPubliques,
  promotionsPubliquesWhere,
} from './promotions-publiques.rules';

describe('promotionsPubliquesWhere', () => {
  const maintenant = new Date('2026-10-03T12:00:00.000Z');

  it('actives, publiques, commencées et pas encore expirées', () => {
    expect(promotionsPubliquesWhere(maintenant)).toEqual({
      status: PromotionStatus.ACTIVE,
      visibility: Visibility.PUBLIC,
      start_date: { lte: maintenant },
      expiration_date: { gte: maintenant },
    });
  });

  it('jamais les promotions réservées à un niveau de fidélité', () => {
    expect(promotionsPubliquesWhere(maintenant).visibility).not.toBe(Visibility.PRIVATE);
  });
});

describe('limitePromotionsPubliques', () => {
  it('12 par défaut, ou si la valeur est absente ou invalide', () => {
    expect(LIMITE_PROMOTIONS_PUBLIQUES).toBe(12);
    expect(limitePromotionsPubliques()).toBe(12);
    expect(limitePromotionsPubliques('abc')).toBe(12);
    expect(limitePromotionsPubliques(0)).toBe(12);
    expect(limitePromotionsPubliques(-5)).toBe(12);
  });

  it('entier, plafonné à 24', () => {
    expect(limitePromotionsPubliques('6')).toBe(6);
    expect(limitePromotionsPubliques(7.9)).toBe(7);
    expect(limitePromotionsPubliques(1000)).toBe(LIMITE_MAX_PROMOTIONS_PUBLIQUES);
    expect(LIMITE_MAX_PROMOTIONS_PUBLIQUES).toBe(24);
  });
});

describe('CHAMPS_PROMOTION_PUBLIQUE', () => {
  it('ni créateur, ni compteurs d’usage, ni ciblage', () => {
    const champs = Object.keys(CHAMPS_PROMOTION_PUBLIQUE);
    for (const interdit of [
      'created_by_id',
      'created_by',
      'current_usage',
      'max_total_usage',
      'visibility',
      'target_standard',
      'target_premium',
      'target_gold',
      'promotion_usages',
      'orders',
    ]) {
      expect(champs).not.toContain(interdit);
    }
  });

  it('tout ce que lisent la carte et la fenêtre de détail du site', () => {
    expect(Object.keys(CHAMPS_PROMOTION_PUBLIQUE)).toEqual(
      expect.arrayContaining([
        'id',
        'title',
        'description',
        'discount_type',
        'discount_value',
        'min_order_amount',
        'max_usage_per_user',
        'start_date',
        'expiration_date',
        'status',
        'coupon_image_url',
        'background_color',
        'text_color',
      ]),
    );
  });
});
