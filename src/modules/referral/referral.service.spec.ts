import { ReferralEarningStatus } from '@prisma/client';
import { ReferralService } from './referral.service';

/**
 * Tests unitaires du parrainage : anti-abus d'`applyReferralCode`, lecture du
 * code saisi, attribution des codes CN-PRENOM et gestes du backoffice.
 * Isolé : prisma / settings / voucher / logger greffés sur le prototype.
 */
type Client = {
  id: string;
  first_name?: string | null;
  last_name?: string | null;
  phone?: string | null;
  referral_code?: string | null;
  referral_code_ancien?: string | null;
};

/** Filtre `where` minimal de Prisma sur les clients (in, not, OR). */
const correspond = (c: Client, where: any): boolean =>
  Object.entries(where ?? {}).every(([cle, cond]: [string, any]) => {
    if (cle === 'OR') return (cond as any[]).some((w) => correspond(c, w));
    const valeur = (c as any)[cle] ?? null;
    if (cond && typeof cond === 'object') {
      if ('in' in cond) return cond.in.includes(valeur);
      if ('not' in cond) return valeur !== cond.not;
    }
    return valeur === cond;
  });

const makeService = (
  m: {
    existingReferral?: any;
    customers?: Client[];
    paidOrder?: any;
    promoCodes?: string[];
    payables?: { id: string; amount: number }[];
  } = {},
) => {
  const clients: Client[] = (m.customers ?? []).map((c) => ({ ...c }));
  const prisma = {
    referral: {
      findUnique: jest.fn().mockResolvedValue(m.existingReferral ?? null),
      create: jest.fn().mockResolvedValue({ id: 'ref-1' }),
      update: jest.fn().mockResolvedValue({}),
    },
    customer: {
      findMany: jest.fn(async ({ where }: any) => clients.filter((c) => correspond(c, where))),
      findUnique: jest.fn(async ({ where }: any) => clients.find((c) => c.id === where.id) ?? null),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const cibles = clients.filter((c) => c.id === where.id && (c.referral_code ?? null) === where.referral_code);
        cibles.forEach((c) => Object.assign(c, data));
        return { count: cibles.length };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const c = clients.find((x) => x.id === where.id)!;
        Object.assign(c, data);
        return c;
      }),
    },
    promoCode: {
      findMany: jest.fn(async ({ where }: any) =>
        (m.promoCodes ?? []).filter((code) => where.code.in.includes(code)).map((code) => ({ code })),
      ),
    },
    order: { findFirst: jest.fn().mockResolvedValue(m.paidOrder ?? null) },
    referralEarning: {
      findMany: jest.fn().mockResolvedValue(m.payables ?? []),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
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
  return { service, prisma, voucherService, clients };
};

const apply = (s: ReferralService, refereeId: string, code: string) =>
  (s as any).applyReferralCode(refereeId, code) as Promise<any>;

const parrain: Client = { id: 'parrain', first_name: 'Awa', referral_code: 'CN-AWA', referral_code_ancien: 'CNABC23' };

describe('ReferralService.applyReferralCode (anti-abus)', () => {
  it('code vide → rejeté', async () => {
    const { service } = makeService();
    await expect(apply(service, 'me', '  ')).rejects.toThrow(/requis/i);
  });

  it('filleul déjà parrainé → rejeté', async () => {
    const { service } = makeService({ existingReferral: { id: 'x' }, customers: [parrain] });
    await expect(apply(service, 'me', 'CN-AWA')).rejects.toThrow(/déjà utilisé/i);
  });

  it('code invalide (aucun parrain) → rejeté', async () => {
    const { service } = makeService({ customers: [parrain] });
    await expect(apply(service, 'me', 'CN-BINTOU')).rejects.toThrow(/invalide/i);
  });

  it('auto-parrainage → rejeté', async () => {
    const { service } = makeService({ customers: [parrain] });
    await expect(apply(service, 'parrain', 'CN-AWA')).rejects.toThrow(/propre code/i);
  });

  it('filleul déjà client (commande payée) → rejeté', async () => {
    const { service } = makeService({ customers: [parrain], paidOrder: { id: 'o1' } });
    await expect(apply(service, 'me', 'CN-AWA')).rejects.toThrow(/nouveaux clients/i);
  });

  it.each(['CN-AWA', 'cn-awa', 'CN AWA', 'CNAWA', 'awa', ' Awa '])(
    'saisie « %s » → parrainage créé avec CN-AWA',
    async (saisie) => {
      const { service, prisma } = makeService({ customers: [parrain] });
      const res = await apply(service, 'me', saisie);
      expect(res).toMatchObject({ applied: true });
      expect(prisma.referral.create.mock.calls[0][0].data).toMatchObject({
        referrer_id: 'parrain',
        referral_code: 'CN-AWA',
      });
    },
  );

  it('ancien code d’avant le 03/11 → toujours valable', async () => {
    const { service, prisma } = makeService({ customers: [parrain] });
    await apply(service, 'me', 'cnabc23');
    expect(prisma.referral.create.mock.calls[0][0].data).toMatchObject({
      referrer_id: 'parrain',
      referral_code: 'CNABC23',
    });
  });
});

describe('ReferralService : attribution du code CN-PRENOM', () => {
  const code = (s: ReferralService, id: string) => s.getOrCreateReferralCode(id);

  it('prénom libre → CN-PRENOM, sans accents ni apostrophe', async () => {
    const { service } = makeService({ customers: [{ id: 'c1', first_name: "Hélène", last_name: "N'Guessan" }] });
    expect(await code(service, 'c1')).toBe('CN-HELENE');
  });

  it('prénom pris → CN-NOM', async () => {
    const { service } = makeService({
      customers: [parrain, { id: 'c1', first_name: 'Awa', last_name: 'Koné' }],
    });
    expect(await code(service, 'c1')).toBe('CN-KONE');
  });

  it('prénom et nom pris → CN-PRENOM2, puis CN-PRENOM3', async () => {
    const { service } = makeService({
      customers: [
        parrain,
        { id: 'p2', first_name: 'Bintou', referral_code: 'CN-KONE' },
        { id: 'p3', referral_code: 'CN-AWA2' },
        { id: 'c1', first_name: 'Awa', last_name: 'Koné' },
      ],
    });
    expect(await code(service, 'c1')).toBe('CN-AWA3');
  });

  it('code promo du même nom ou ancien code qui s’écrit pareil → sauté', async () => {
    const { service } = makeService({
      customers: [
        { id: 'p1', referral_code: 'CN-X', referral_code_ancien: 'CNKONE' },
        { id: 'c1', first_name: 'Awa', last_name: 'Koné' },
      ],
      promoCodes: ['CN-AWA'],
    });
    expect(await code(service, 'c1')).toBe('CN-AWA2');
  });

  it('sans nom → CN-CLIENT, jamais les chiffres du téléphone', async () => {
    const { service } = makeService({ customers: [{ id: 'c1', phone: '+2250140735992' }] });
    expect(await code(service, 'c1')).toBe('CN-CLIENT');
  });

  it('code déjà attribué → rendu tel quel', async () => {
    const { service, prisma } = makeService({ customers: [parrain] });
    expect(await code(service, 'parrain')).toBe('CN-AWA');
    expect(prisma.customer.updateMany).not.toHaveBeenCalled();
  });
});

describe('ReferralService : gestes du backoffice', () => {
  it('changer le code : remis en forme, refusé s’il est pris', async () => {
    const { service, clients } = makeService({
      customers: [parrain, { id: 'p2', first_name: 'Bintou', referral_code: 'CN-BINTOU' }],
    });
    jest.spyOn(service, 'adminAmbassadorDetail').mockResolvedValue({} as any);

    await service.adminChangerCode('parrain', ' awa la star ');
    expect(clients[0].referral_code).toBe('CN-AWALASTAR');

    await expect(service.adminChangerCode('parrain', 'CN-BINTOU')).rejects.toThrow(/déjà pris/);
    await expect(service.adminChangerCode('parrain', 'CN-BA123')).rejects.toThrow(/Carte de la Nation/);
    await expect(service.adminChangerCode('parrain', 'CN-')).rejects.toThrow(/CN- suivi/);
  });

  it('créer un parrain déjà parrain → refusé avec son code', async () => {
    const { service } = makeService({ customers: [parrain] });
    await expect(service.adminCreerParrain({ customer_id: 'parrain' })).rejects.toThrow(/CN-AWA/);
  });

  it('rattacher un filleul déjà client → refusé', async () => {
    const { service } = makeService({
      customers: [parrain, { id: 'f1', first_name: 'Yao' }],
      paidOrder: { id: 'o1' },
    });
    await expect(service.adminRattacherFilleul('parrain', 'f1')).rejects.toThrow(/commande payée/);
  });

  it('marquer payé : le montant doit être le solde payable', async () => {
    const { service, prisma } = makeService({
      payables: [
        { id: 'e1', amount: 1000 },
        { id: 'e2', amount: 500 },
      ],
    });
    await expect(service.adminVerser('parrain', { amount: 1000 }, 'admin')).rejects.toThrow(/1\s500 FCFA/);
    expect(prisma.referralEarning.updateMany).not.toHaveBeenCalled();
  });

  it('marquer payé sans rien de payable → refusé', async () => {
    const { service } = makeService({ payables: [] });
    await expect(service.adminVerser('parrain', { amount: 1 }, 'admin')).rejects.toThrow(/Aucun gain/);
  });

  it('marquer payé : tous les gains payables passent payés ensemble', async () => {
    const { service, prisma } = makeService({ payables: [{ id: 'e1', amount: 1500 }] });
    (prisma.referralEarning as any).aggregate = jest.fn().mockResolvedValue({ _sum: { amount: 1500 } });
    const res = await service.adminVerser('parrain', { amount: 1500, note: ' Wave 07 ' }, 'admin');
    expect(prisma.referralEarning.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: { in: ['e1'] }, status: ReferralEarningStatus.PAYABLE },
      data: { status: ReferralEarningStatus.PAID, paid_by: 'admin', note: 'Wave 07' },
    });
    expect(res).toMatchObject({ amount: 1500, note: 'Wave 07' });
  });
});
