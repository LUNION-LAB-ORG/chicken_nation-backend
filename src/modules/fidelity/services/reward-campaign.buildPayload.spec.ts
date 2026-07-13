import { EntityStatus, RewardType } from '@prisma/client';
import { RewardCampaignService } from './reward-campaign.service';

/**
 * Tests unitaires de `buildPayload` (validation + snapshot du contenu de campagne
 * selon le type). Testée en isolation : on greffe un prisma mocké sur le prototype
 * (la méthode n'accède qu'à `prisma.dish` / `prisma.promoCode`).
 */
const makeService = (overrides: { dish?: any; promo?: any } = {}) => {
  const prisma = {
    dish: { findUnique: jest.fn().mockResolvedValue(overrides.dish ?? null) },
    promoCode: { findUnique: jest.fn().mockResolvedValue(overrides.promo ?? null) },
  };
  const service = Object.create(RewardCampaignService.prototype) as RewardCampaignService;
  (service as any).prisma = prisma;
  return { service, prisma };
};

const build = (service: RewardCampaignService, type: RewardType, payload: any) =>
  (service as any).buildPayload(type, payload) as Promise<Record<string, any>>;

const activeDish = (over: Partial<Record<string, any>> = {}) => ({
  id: 'd1',
  name: 'Tiramisu',
  price: 2000,
  image: null,
  entity_status: EntityStatus.ACTIVE,
  ...over,
});

describe('RewardCampaignService.buildPayload', () => {
  describe('GIFT (plat offert)', () => {
    it('sans dish_id → rejeté', async () => {
      const { service } = makeService();
      await expect(build(service, RewardType.GIFT, {})).rejects.toThrow(/plat|dish_id/i);
    });

    it('plat introuvable → rejeté', async () => {
      const { service } = makeService({ dish: null });
      await expect(build(service, RewardType.GIFT, { dish_id: 'x' })).rejects.toThrow(
        /introuvable|indisponible/i,
      );
    });

    it('plat supprimé (DELETED) → rejeté', async () => {
      const { service } = makeService({ dish: activeDish({ entity_status: EntityStatus.DELETED }) });
      await expect(build(service, RewardType.GIFT, { dish_id: 'd1' })).rejects.toThrow();
    });

    it('plat valide → snapshot { item_type:DISH, dish_id, name, price, image }', async () => {
      const { service } = makeService({ dish: activeDish({ image: 'http://img' }) });
      const res = await build(service, RewardType.GIFT, { dish_id: 'd1' });
      expect(res).toMatchObject({
        item_type: 'DISH',
        dish_id: 'd1',
        name: 'Tiramisu',
        price: 2000,
        label: 'Tiramisu', // défaut = nom du plat
        image: 'http://img',
      });
    });

    it('label personnalisé conservé (sinon = nom du plat)', async () => {
      const { service } = makeService({ dish: activeDish() });
      const res = await build(service, RewardType.GIFT, { dish_id: 'd1', label: 'Dessert surprise' });
      expect(res.label).toBe('Dessert surprise');
    });
  });

  describe('VOUCHER (bon)', () => {
    it('montant ≤ 0 → rejeté', async () => {
      const { service } = makeService();
      await expect(build(service, RewardType.VOUCHER, { amount: 0 })).rejects.toThrow(/positif/i);
    });

    it('montant valide → { amount }', async () => {
      const { service } = makeService();
      await expect(build(service, RewardType.VOUCHER, { amount: 1500 })).resolves.toEqual({
        amount: 1500,
      });
    });
  });

  describe('PROMO_CODE (code existant)', () => {
    it('sans code → rejeté', async () => {
      const { service } = makeService();
      await expect(build(service, RewardType.PROMO_CODE, {})).rejects.toThrow(/code/i);
    });

    it('code inexistant/inactif → rejeté', async () => {
      const { service } = makeService({ promo: null });
      await expect(build(service, RewardType.PROMO_CODE, { code: 'NOPE' })).rejects.toThrow(
        /introuvable|inactif/i,
      );
    });

    it('code actif → snapshot de la remise', async () => {
      const { service } = makeService({
        promo: {
          code: 'WELCOME',
          is_active: true,
          entity_status: EntityStatus.ACTIVE,
          discount_type: 'PERCENTAGE',
          discount_value: 10,
          description: 'Bienvenue',
        },
      });
      const res = await build(service, RewardType.PROMO_CODE, { code: 'WELCOME' });
      expect(res).toMatchObject({
        code: 'WELCOME',
        discount_type: 'PERCENTAGE',
        discount_value: 10,
        description: 'Bienvenue',
      });
    });
  });

  it('POINTS → rejeté (réservé aux commandes, pas aux campagnes)', async () => {
    const { service } = makeService();
    await expect(build(service, RewardType.POINTS, {})).rejects.toThrow();
  });
});
