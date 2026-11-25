/**
 * PaystackService.initialiser : ce qui part chez Paystack. Le réseau est
 * remplacé par un faux `fetch` ; la base par un faux Prisma.
 */
import { BadRequestException } from '@nestjs/common';
import { PaystackService } from './paystack.service';

// Comme les sous-comptes du client : 99 % pour le restaurant, 1 % pour le compte principal.
const SOUS_COMPTE = {
  subaccount_code: 'ACCT_zone4abc',
  business_name: 'Zone 4',
  percentage_charge: 1,
  active: true,
  currency: 'XOF',
};

function monter(options: { sousCompte?: Record<string, unknown> | null; code?: string | null; reglages?: Record<string, string> } = {}) {
  const reglages: Record<string, string> = {
    paystack_secret_key: 'sk_test_abcdefgh12345678',
    ...(options.reglages ?? {}),
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

  it('Mobile Money : sous-compte du restaurant, frais portés par lui, commande + 3,3 % de frais, ×100 en XOF, seul moyen proposé', async () => {
    const m = monter();
    global.fetch = m.fetchFaux as never;
    const r = await m.service.initialiser({ order: commande, email: null, canal: 'APP', moyen: 'mobile_money', callbackUrl: 'https://api.test/retour' });

    expect(r.authorization_url).toBe('https://checkout.paystack.com/abc123');
    expect(r.reference).toMatch(/^ORD-261125-44839-P[A-Z0-9]+$/);
    // 10 500 F à 2,3 % + 1 % : 346,5 F, arrondis au franc supérieur.
    expect(r).toEqual(expect.objectContaining({ montant: 10500, frais: 347, total: 10847, moyen: 'mobile_money' }));
    const init = m.appels.find((a) => a.url.endsWith('/transaction/initialize'))!;
    expect(init.corps).toEqual(
      expect.objectContaining({
        amount: 1_084_700,
        currency: 'XOF',
        subaccount: 'ACCT_zone4abc',
        bearer: 'subaccount',
        channels: ['mobile_money'],
        callback_url: 'https://api.test/retour',
        reference: r.reference,
      }),
    );
    // Jamais de part fixe vers le compte principal.
    expect(init.corps).not.toHaveProperty('transaction_charge');
    expect(String(init.corps!.email)).toMatch(/@clients\.chicken-nation\.com$/);
    expect(JSON.parse(String(init.corps!.metadata))).toEqual(
      expect.objectContaining({ order_id: 'o-1', restaurant_id: 'r-1', montant_commande: 10500, frais: 347 }),
    );
    // Tentative enregistrée AVANT l'appel, avec le sous-compte, le moyen et les frais figés.
    expect(m.tentatives[0]).toEqual(
      expect.objectContaining({ reference: r.reference, montant: 10500, frais: 347, moyen: 'mobile_money', sous_compte: 'ACCT_zone4abc', canal: 'APP' }),
    );
  });

  it('carte : 3,8 % + 1 %, et seule la carte est proposée ; taux réglés au back-office repris', async () => {
    const m = monter();
    global.fetch = m.fetchFaux as never;
    const r = await m.service.initialiser({ order: commande, email: null, canal: 'WEB', moyen: 'card', callbackUrl: 'https://site.test/retour' });
    expect(r).toEqual(expect.objectContaining({ frais: 504, total: 11004 }));
    expect(m.appels.find((a) => a.url.endsWith('/transaction/initialize'))!.corps).toEqual(
      expect.objectContaining({ amount: 1_100_400, channels: ['card'] }),
    );

    const regle = monter({ reglages: { paystack_frais_mobile_money: '2', paystack_frais_carte: '4,5', paystack_frais_supplement: '1' } });
    global.fetch = regle.fetchFaux as never;
    expect((await regle.service.initialiser({ order: commande, email: null, canal: 'APP', moyen: 'mobile_money', callbackUrl: 'https://api.test/r' })).frais).toBe(315);
    expect((await regle.service.initialiser({ order: commande, email: null, canal: 'APP', moyen: 'card', callbackUrl: 'https://api.test/r' })).frais).toBe(578);
  });

  it('e-mail du client refusé par Paystack : relancé une fois avec l’adresse technique', async () => {
    const m = monter();
    const emails: string[] = [];
    global.fetch = jest.fn(async (url: string, init: { method: string; body?: string }) => {
      const corps = init.body ? JSON.parse(init.body) : null;
      if (url.endsWith('/transaction/initialize')) {
        emails.push(corps.email);
        if (corps.email === 'client@domaine-refuse.com') {
          return new Response(JSON.stringify({ status: false, message: '"email" must be a valid email' }), { status: 400 });
        }
      }
      return m.fetchFaux(url, init);
    }) as never;
    const r = await m.service.initialiser({ order: commande, email: 'client@domaine-refuse.com', canal: 'APP', moyen: 'mobile_money', callbackUrl: 'https://api.test/r' });
    expect(r.authorization_url).toBe('https://checkout.paystack.com/abc123');
    expect(emails).toHaveLength(2);
    expect(emails[0]).toBe('client@domaine-refuse.com');
    expect(emails[1]).toMatch(/^[0-9a-f]{24}@clients\.chicken-nation\.com$/);
  });

  it('restaurant sans sous-compte, ou sous-compte qui laisse au compte principal plus que le supplément : refus, rien chez Paystack', async () => {
    for (const cas of [
      monter({ code: null }),
      monter({ sousCompte: { ...SOUS_COMPTE, percentage_charge: 5 } }),
      // Supplément ramené à 0 : le 1 % du compte principal n'est plus couvert.
      monter({ reglages: { paystack_frais_supplement: '0' } }),
      monter({ sousCompte: null }),
    ]) {
      global.fetch = cas.fetchFaux as never;
      await expect(
        cas.service.initialiser({ order: commande, email: null, canal: 'APP', moyen: 'mobile_money', callbackUrl: 'https://api.test/retour' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(cas.appels.some((a) => a.url.endsWith('/transaction/initialize'))).toBe(false);
      expect(cas.tentatives).toHaveLength(0);
    }
  });
});
