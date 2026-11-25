/**
 * PaystackService.initialiser : ce qui part chez Paystack. Le réseau est
 * remplacé par un faux `fetch` ; la base par un faux Prisma.
 */
import { BadRequestException } from '@nestjs/common';
import { PaystackService } from './paystack.service';

const SOUS_COMPTE = {
  subaccount_code: 'ACCT_zone4abc',
  business_name: 'Zone 4',
  percentage_charge: 0,
  active: true,
  currency: 'XOF',
};

function monter(options: { sousCompte?: Record<string, unknown> | null; code?: string | null } = {}) {
  const reglages: Record<string, string> = {
    paystack_secret_key: 'sk_test_abcdefgh12345678',
    ...(options.code !== null ? { 'paystack.r-1.subaccount_code': options.code ?? 'ACCT_zone4abc' } : {}),
  };
  const settings = {
    getMany: jest.fn(async (cles: string[]) => Object.fromEntries(cles.filter((c) => c in reglages).map((c) => [c, reglages[c]]))),
    get: jest.fn(async (c: string) => reglages[c] ?? null),
  };
  const tentatives: Record<string, unknown>[] = [];
  const prisma = {
    tentativePaiement: {
      create: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        tentatives.push(data);
        return data;
      }),
      update: jest.fn(async () => ({})),
    },
  };
  const appels: { url: string; methode: string; corps: Record<string, unknown> | null }[] = [];
  const fetchFaux = jest.fn(async (url: string, init: { method: string; body?: string }) => {
    const corps = init.body ? JSON.parse(init.body) : null;
    appels.push({ url, methode: init.method, corps });
    if (url.includes('/subaccount/')) {
      return new Response(JSON.stringify(options.sousCompte === null ? { status: false, message: 'Subaccount not found' } : { status: true, data: options.sousCompte ?? SOUS_COMPTE }), {
        status: options.sousCompte === null ? 404 : 200,
      });
    }
    if (url.endsWith('/transaction/initialize')) {
      return new Response(
        JSON.stringify({ status: true, data: { authorization_url: 'https://checkout.paystack.com/abc123', access_code: 'abc123', reference: corps.reference } }),
        { status: 200 },
      );
    }
    return new Response('{}', { status: 500 });
  });
  const service = new PaystackService(settings as never, prisma as never);
  return { service, appels, tentatives, fetchFaux };
}

const commande = { id: 'o-1', reference: 'ORD-261125-44839', amount: 10500, restaurant_id: 'r-1', customer_id: 'c-1' };

describe('PaystackService.initialiser', () => {
  const fetchOriginal = global.fetch;
  afterEach(() => {
    global.fetch = fetchOriginal;
  });

  it('paiement sur le sous-compte du restaurant, frais portés par lui, montant ×100 en XOF, Mobile Money et carte', async () => {
    const m = monter();
    global.fetch = m.fetchFaux as never;
    const r = await m.service.initialiser({ order: commande, email: null, canal: 'APP', callbackUrl: 'https://api.test/retour' });

    expect(r.authorization_url).toBe('https://checkout.paystack.com/abc123');
    expect(r.reference).toMatch(/^ORD-261125-44839-P[A-Z0-9]+$/);
    const init = m.appels.find((a) => a.url.endsWith('/transaction/initialize'))!;
    expect(init.corps).toEqual(
      expect.objectContaining({
        amount: 1_050_000,
        currency: 'XOF',
        subaccount: 'ACCT_zone4abc',
        bearer: 'subaccount',
        channels: ['card', 'mobile_money'],
        callback_url: 'https://api.test/retour',
        reference: r.reference,
      }),
    );
    // Jamais de part fixe vers le compte principal.
    expect(init.corps).not.toHaveProperty('transaction_charge');
    expect(String(init.corps!.email)).toMatch(/@clients\.chicken-nation\.com$/);
    expect(JSON.parse(String(init.corps!.metadata))).toEqual(expect.objectContaining({ order_id: 'o-1', restaurant_id: 'r-1' }));
    // Tentative enregistrée AVANT l'appel, avec le sous-compte figé.
    expect(m.tentatives[0]).toEqual(expect.objectContaining({ reference: r.reference, montant: 10500, sous_compte: 'ACCT_zone4abc', canal: 'APP' }));
  });

  it('restaurant sans sous-compte, ou sous-compte qui laisse une part au compte principal : refus, rien chez Paystack', async () => {
    for (const cas of [monter({ code: null }), monter({ sousCompte: { ...SOUS_COMPTE, percentage_charge: 5 } }), monter({ sousCompte: null })]) {
      global.fetch = cas.fetchFaux as never;
      await expect(
        cas.service.initialiser({ order: commande, email: null, canal: 'APP', callbackUrl: 'https://api.test/retour' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(cas.appels.some((a) => a.url.endsWith('/transaction/initialize'))).toBe(false);
      expect(cas.tentatives).toHaveLength(0);
    }
  });
});
