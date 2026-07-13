import { ReferralService } from './referral.service';

/**
 * Tests unitaires du parrainage (anti-abus d'`applyReferralCode` + format du code).
 * Isolé : prisma / settings / voucher / logger greffés sur le prototype.
 */
const makeService = (
  m: { existingReferral?: any; referrerByCode?: any; paidOrder?: any } = {},
) => {
  const prisma = {
    referral: {
      findUnique: jest.fn().mockResolvedValue(m.existingReferral ?? null),
      create: jest.fn().mockResolvedValue({ id: 'ref-1' }),
      update: jest.fn().mockResolvedValue({}),
    },
    customer: { findFirst: jest.fn().mockResolvedValue(m.referrerByCode ?? null) },
    order: { findFirst: jest.fn().mockResolvedValue(m.paidOrder ?? null) },
    user: { findFirst: jest.fn().mockResolvedValue(null), findUnique: jest.fn().mockResolvedValue(null) },
  };
  const settingsService = {
    get: jest.fn().mockResolvedValue(null),
    getJson: jest.fn().mockResolvedValue(null),
  };
  const voucherService = { createForCustomer: jest.fn().mockResolvedValue({ id: 'v-1' }) };
  const service = Object.create(ReferralService.prototype) as ReferralService;
  (service as any).prisma = prisma;
  (service as any).settingsService = settingsService;
  (service as any).voucherService = voucherService;
  (service as any).logger = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
  return { service, prisma, voucherService };
};

const apply = (s: ReferralService, refereeId: string, code: string) =>
  (s as any).applyReferralCode(refereeId, code) as Promise<any>;

describe('ReferralService.applyReferralCode (anti-abus)', () => {
  it('code vide → rejeté', async () => {
    const { service } = makeService();
    await expect(apply(service, 'me', '  ')).rejects.toThrow(/requis/i);
  });

  it('filleul déjà parrainé → rejeté', async () => {
    const { service } = makeService({ existingReferral: { id: 'x' } });
    await expect(apply(service, 'me', 'CNABC23')).rejects.toThrow(/déjà utilisé/i);
  });

  it('code invalide (aucun parrain) → rejeté', async () => {
    const { service } = makeService({ referrerByCode: null });
    await expect(apply(service, 'me', 'CNBADXX')).rejects.toThrow(/invalide/i);
  });

  it('auto-parrainage → rejeté', async () => {
    const { service } = makeService({ referrerByCode: { id: 'me' } });
    await expect(apply(service, 'me', 'CNSELF9')).rejects.toThrow(/propre code/i);
  });

  it('filleul déjà client (commande payée) → rejeté', async () => {
    const { service } = makeService({ referrerByCode: { id: 'parrain' }, paidOrder: { id: 'o1' } });
    await expect(apply(service, 'me', 'CNABC23')).rejects.toThrow(/nouveaux clients/i);
  });

  it('cas valide → parrainage créé', async () => {
    const { service, prisma } = makeService({ referrerByCode: { id: 'parrain' }, paidOrder: null });
    const res = await apply(service, 'me', 'cnabc23'); // minuscule → normalisé
    expect(res).toMatchObject({ applied: true });
    expect(prisma.referral.create).toHaveBeenCalledTimes(1);
    // Code normalisé en MAJUSCULES + snapshot dans la ligne créée.
    expect(prisma.referral.create.mock.calls[0][0].data.referral_code).toBe('CNABC23');
  });
});

describe('ReferralService.generateCode', () => {
  it('préfixe CN + 6 caractères non ambigus (ni 0/O/1/I)', () => {
    const { service } = makeService();
    for (let i = 0; i < 30; i++) {
      const code = (service as any).generateCode() as string;
      expect(code).toMatch(/^CN[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
    }
  });
});
