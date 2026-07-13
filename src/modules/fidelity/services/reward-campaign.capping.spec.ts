import { RewardCampaignService } from './reward-campaign.service';

/**
 * Tests unitaires du capping anti-fatigue (`applyCapping`). Testé en isolation :
 * on greffe un prisma + un settingsService mockés sur le prototype.
 */
const makeService = (opts: { cooldown?: string | null; recent?: string[] } = {}) => {
  const prisma = {
    reward: {
      findMany: jest
        .fn()
        .mockResolvedValue((opts.recent ?? []).map((customer_id) => ({ customer_id }))),
    },
  };
  const settingsService = {
    get: jest.fn().mockResolvedValue(opts.cooldown === undefined ? '7' : opts.cooldown),
  };
  const service = Object.create(RewardCampaignService.prototype) as RewardCampaignService;
  (service as any).prisma = prisma;
  (service as any).settingsService = settingsService;
  return { service, prisma, settingsService };
};

const applyCapping = (service: RewardCampaignService, ids: string[]) =>
  (service as any).applyCapping(ids) as Promise<string[]>;

describe('RewardCampaignService.applyCapping (anti-fatigue)', () => {
  it('cooldown = 0 → aucun filtrage (capping désactivé), pas de requête', async () => {
    const { service, prisma } = makeService({ cooldown: '0' });
    const res = await applyCapping(service, ['a', 'b']);
    expect(res).toEqual(['a', 'b']);
    expect(prisma.reward.findMany).not.toHaveBeenCalled();
  });

  it('aucun cadeau récent → tous les clients conservés', async () => {
    const { service } = makeService({ cooldown: '7', recent: [] });
    const res = await applyCapping(service, ['a', 'b', 'c']);
    expect(res).toEqual(['a', 'b', 'c']);
  });

  it('clients récemment gâtés → retirés de la cible', async () => {
    const { service } = makeService({ cooldown: '7', recent: ['b'] });
    const res = await applyCapping(service, ['a', 'b', 'c']);
    expect(res).toEqual(['a', 'c']);
  });

  it('réglage absent → cooldown par défaut (7 j), filtrage actif', async () => {
    const { service, settingsService } = makeService({ cooldown: null, recent: ['a'] });
    const res = await applyCapping(service, ['a', 'b']);
    expect(res).toEqual(['b']);
    expect(settingsService.get).toHaveBeenCalledWith('reward.capping.cooldown_days');
  });

  it('réglage invalide → défaut 7 j sans crash', async () => {
    const { service } = makeService({ cooldown: 'abc', recent: [] });
    const res = await applyCapping(service, ['a']);
    expect(res).toEqual(['a']);
  });
});
