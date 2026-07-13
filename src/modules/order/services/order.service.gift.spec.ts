import { BadRequestException } from '@nestjs/common';
import { RewardStatus } from '@prisma/client';
import { OrderService } from './order.service';

/**
 * Tests unitaires de `validateGiftLines` (validation des lignes-cadeau à la
 * création de commande). On la teste EN ISOLATION : OrderService a ~10 dépendances
 * de constructeur, mais la méthode n'utilise que `this.prisma` → on greffe un prisma
 * mocké sur le prototype (pas d'instanciation complète).
 */
const makeService = (rewards: any[]) => {
  const prisma = { reward: { findMany: jest.fn().mockResolvedValue(rewards) } };
  const service = Object.create(OrderService.prototype) as OrderService;
  (service as any).prisma = prisma;
  return { service, prisma };
};

const paid = (dish_id = 'dish-paid') => ({ dish_id, quantity: 1, epice: false });
const gift = (reward_id: string, dish_id = 'dish-gift') => ({
  dish_id,
  quantity: 1,
  epice: false,
  reward_id,
});

const run = (service: OrderService, items: any[], customerId = 'cust-1') =>
  (service as any).validateGiftLines(items, customerId) as Promise<{
    dishLineIndexes: Set<number>;
    suppByLine: Map<number, Set<string>>;
    rewardIds: string[];
  }>;

const scratched = (id: string, dish_id = 'dish-gift', expires_at: Date | null = null) => ({
  id,
  status: RewardStatus.SCRATCHED,
  expires_at,
  payload: { dish_id },
});

// Cadeau supplément : sur une ligne-plat payante, un supplément porte reward_id.
const giftSupp = (reward_id: string, dish_id = 'dish-paid', supplement_id = 'supp-1') => ({
  dish_id,
  quantity: 1,
  epice: false,
  supplements: [{ id: supplement_id, quantity: 1, reward_id }],
});
const scratchedSupp = (id: string, supplement_id = 'supp-1') => ({
  id,
  status: RewardStatus.SCRATCHED,
  expires_at: null,
  payload: { item_type: 'SUPPLEMENT', supplement_id },
});

describe('OrderService.validateGiftLines', () => {
  it('aucune ligne-cadeau → map vide, aucun accès à Reward', async () => {
    const { service, prisma } = makeService([]);
    const res = await run(service, [paid(), paid()]);
    expect(res.dishLineIndexes.size).toBe(0);
    expect(res.rewardIds).toHaveLength(0);
    expect(prisma.reward.findMany).not.toHaveBeenCalled();
  });

  it('commande 100 % cadeau → rejetée (au moins un article payant requis)', async () => {
    const { service } = makeService([]);
    await expect(run(service, [gift('r1')])).rejects.toThrow(BadRequestException);
    await expect(run(service, [gift('r1')])).rejects.toThrow(/seul/i);
  });

  it('même cadeau sur deux lignes → rejeté', async () => {
    const { service } = makeService([]);
    await expect(run(service, [paid(), gift('r1'), gift('r1')])).rejects.toThrow(/deux fois/i);
  });

  it('cadeau introuvable (pas au client / mauvais type) → rejeté', async () => {
    const { service } = makeService([]); // findMany → []
    await expect(run(service, [paid(), gift('r1')])).rejects.toThrow(/introuvable/i);
  });

  it('cadeau déjà consommé → rejeté', async () => {
    const { service } = makeService([
      { id: 'r1', status: RewardStatus.CONSUMED, expires_at: null, payload: { dish_id: 'dish-gift' } },
    ]);
    await expect(run(service, [paid(), gift('r1')])).rejects.toThrow(/déjà été utilisé/i);
  });

  it('cadeau pas encore gratté (PENDING) → rejeté', async () => {
    const { service } = makeService([
      { id: 'r1', status: RewardStatus.PENDING, expires_at: null, payload: { dish_id: 'dish-gift' } },
    ]);
    await expect(run(service, [paid(), gift('r1')])).rejects.toThrow(/gratté/i);
  });

  it('cadeau expiré → rejeté', async () => {
    const { service } = makeService([scratched('r1', 'dish-gift', new Date(Date.now() - 1000))]);
    await expect(run(service, [paid(), gift('r1')])).rejects.toThrow(/expiré/i);
  });

  it('plat de la ligne ≠ plat du cadeau → rejeté (anti-substitution)', async () => {
    const { service } = makeService([scratched('r1', 'AUTRE-plat')]);
    await expect(run(service, [paid(), gift('r1', 'dish-gift')])).rejects.toThrow(/ne correspond pas/i);
  });

  it('cadeau valide accompagné d’un article payant → ligne-cadeau + rewardId', async () => {
    const { service } = makeService([scratched('r1', 'dish-gift')]);
    const res = await run(service, [paid(), gift('r1', 'dish-gift')]);
    expect(res.dishLineIndexes.has(1)).toBe(true);
    expect(res.rewardIds).toEqual(['r1']);
  });

  it('cadeau non expiré (expires_at futur) → accepté', async () => {
    const { service } = makeService([scratched('r1', 'dish-gift', new Date(Date.now() + 60_000))]);
    const res = await run(service, [paid(), gift('r1', 'dish-gift')]);
    expect(res.dishLineIndexes.has(1)).toBe(true);
  });

  it('supplément-cadeau valide (sur un plat payant) → suppByLine + rewardId', async () => {
    const { service } = makeService([scratchedSupp('rs1', 'supp-1')]);
    const res = await run(service, [giftSupp('rs1', 'dish-paid', 'supp-1')]);
    expect(res.dishLineIndexes.size).toBe(0); // pas une ligne-cadeau (plat payant)
    expect(res.suppByLine.get(0)?.has('supp-1')).toBe(true);
    expect(res.rewardIds).toEqual(['rs1']);
  });

  it('supplément-cadeau ne correspondant pas au cadeau → rejeté', async () => {
    const { service } = makeService([scratchedSupp('rs1', 'AUTRE-supp')]);
    await expect(run(service, [giftSupp('rs1', 'dish-paid', 'supp-1')])).rejects.toThrow(
      /supplément ne correspond pas/i,
    );
  });
});
