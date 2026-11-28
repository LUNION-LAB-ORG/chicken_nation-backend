/**
 * Journal d'audit : les repères d'une ligne (référence, personne concernée,
 * numéro) sont relus à l'écriture, et la recherche les lit (28/11).
 */
import { AuditEntry, AuditService } from './audit.service';

const COMMANDE = 'a4559e28-1111-4111-8111-111111111111';
const CLIENT = 'c8a3e1f8-2222-4222-8222-222222222222';
const AVIS = '11111111-1111-4111-8111-111111111111';

const CLIENTE = { first_name: 'Awa Mariam', last_name: 'Koné', phone: '+2250707070707', email: null };
const COMMANDE_LUE = {
  reference: 'ORD-261128-00042',
  fullname: 'Mariam',
  phone: '0707070707',
  email: null,
  customer: CLIENTE,
};

const entree = (surcharge: Partial<AuditEntry> = {}): AuditEntry => ({
  actor_id: 'u1',
  actor_name: 'Agent Yao',
  actor_role: 'CALL_CENTER',
  action: 'UPDATE',
  module: 'orders',
  entity_id: COMMANDE,
  method: 'PATCH',
  path: `/api/v1/orders/${COMMANDE}/status`,
  status_code: 200,
  ...surcharge,
});

function monter(lectures: Record<string, jest.Mock> = {}) {
  const create = jest.fn().mockResolvedValue({});
  const modele = (nom: string) => ({ findUnique: lectures[nom] ?? jest.fn().mockResolvedValue(null) });
  const prisma = {
    auditLog: { create, findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(0) },
    order: modele('order'),
    customer: modele('customer'),
    user: modele('user'),
    deliverer: modele('deliverer'),
    delivery: modele('delivery'),
    paiement: modele('paiement'),
    incident: modele('incident'),
    course: modele('course'),
    crmContact: modele('crmContact'),
  };
  const service = new AuditService(prisma as never);
  jest.spyOn(service['logger'], 'warn').mockImplementation(() => undefined);
  /** `record` n'attend rien : on laisse l'écriture se terminer. */
  const ecrite = async () => {
    for (let i = 0; i < 20 && !create.mock.calls.length; i++) await new Promise((r) => setImmediate(r));
    return create.mock.calls[0]?.[0]?.data;
  };
  return { service, prisma, create, ecrite };
}

describe('AuditService.record : repères de la ligne', () => {
  it('action sur une commande : référence, client et numéro figés sur la ligne', async () => {
    const order = jest.fn().mockResolvedValue(COMMANDE_LUE);
    const { service, ecrite } = monter({ order });

    service.record(entree(), { cibles: [{ type: 'order', id: COMMANDE }] });
    const data = await ecrite();

    expect(order).toHaveBeenCalledTimes(1);
    expect(order.mock.calls[0][0].where).toEqual({ id: COMMANDE });
    expect(data).toEqual(
      expect.objectContaining({
        entity_id: COMMANDE,
        actor_name: 'Agent Yao',
        target_ref: 'ORD-261128-00042',
        target_name: 'Awa Mariam Koné',
        target_phone: '+2250707070707',
        search_text: 'ord-261128-00042 awa mariam kone 2250707070707 mariam 0707070707',
      }),
    );
  });

  it('ligne écrite par un module, sans requête : la commande est relue sur sa cible', async () => {
    const order = jest.fn().mockResolvedValue(COMMANDE_LUE);
    const customer = jest.fn().mockResolvedValue(CLIENTE);
    const { service, ecrite } = monter({ order, customer });

    service.record(
      entree({ action: 'COUPON_APPLIQUE', method: 'POST', path: '/orders/create', metadata: { customer_id: CLIENT } }),
    );
    const data = await ecrite();

    expect(data.target_ref).toBe('ORD-261128-00042');
    // Référence, nom et numéro connus dès la commande : le client n'est pas relu.
    expect(customer).not.toHaveBeenCalled();
  });

  it('paiement KKiaPay : la commande se retrouve par sa référence', async () => {
    const order = jest.fn().mockResolvedValue(COMMANDE_LUE);
    const { service, ecrite } = monter({ order });

    service.record(
      entree({
        module: 'paiements',
        entity_id: 'tx_123',
        method: 'EVENEMENT',
        path: '/kkiapay/webhook',
        metadata: { reference_commande: 'ORD-261128-00042' },
      }),
    );
    const data = await ecrite();

    expect(order.mock.calls[0][0].where).toEqual({ reference: 'ORD-261128-00042' });
    expect(data.target_name).toBe('Awa Mariam Koné');
  });

  it('action sur un client, puis ce que l’agent a saisi', async () => {
    const customer = jest.fn().mockResolvedValue(CLIENTE);
    const { service, ecrite } = monter({ customer });

    service.record(entree({ module: 'customer', entity_id: CLIENT, path: `/api/v1/customer/${CLIENT}` }), {
      cibles: [{ type: 'customer', id: CLIENT }],
      fiches: [{ nom: 'Awa M. Koné', telephone: '+2250707070707', autres: ['awa@exemple.ci'] }],
    });
    const data = await ecrite();

    expect(data).toEqual(
      expect.objectContaining({
        target_ref: null,
        target_name: 'Awa Mariam Koné',
        target_phone: '+2250707070707',
        search_text: 'awa mariam kone 2250707070707 awa m. kone awa@exemple.ci',
      }),
    );
  });

  it('lecture impossible : la ligne s’écrit quand même, sans repère', async () => {
    const order = jest.fn().mockRejectedValue(new Error('P1001'));
    const { service, ecrite } = monter({ order });

    service.record(entree(), { cibles: [{ type: 'order', id: COMMANDE }] });
    const data = await ecrite();

    expect(data.entity_id).toBe(COMMANDE);
    expect(data.target_ref).toBeUndefined();
    expect(data.search_text).toBeUndefined();
  });

  it('cible introuvable ou module sans cible connue : aucune colonne ajoutée', async () => {
    const { service, ecrite, prisma } = monter();

    service.record(entree({ module: 'dishes', path: `/api/v1/dishes/${COMMANDE}` }));
    const data = await ecrite();

    expect(prisma.order.findUnique).not.toHaveBeenCalled();
    expect(data).not.toHaveProperty('target_ref');
  });

  it('retours privés « Ton avis compte » : rien n’est relu ni copié', async () => {
    const { service, ecrite, prisma } = monter();

    service.record(entree({ module: 'avis-prives', entity_id: AVIS, path: `/api/v1/avis-prives/${AVIS}/journal` }), {
      cibles: [{ type: 'customer', id: CLIENT }],
      fiches: [{ nom: 'Awa Koné', telephone: '+2250707000001' }],
    });
    const data = await ecrite();

    expect(prisma.customer.findUnique).not.toHaveBeenCalled();
    expect(JSON.stringify(data)).not.toMatch(/Awa|0707000001/);
  });

  it('repères déjà fournis par le module : gardés tels quels', async () => {
    const { service, ecrite, prisma } = monter();

    service.record(entree({ target_ref: 'ORD-1', search_text: 'ord-1' }));
    const data = await ecrite();

    expect(prisma.order.findUnique).not.toHaveBeenCalled();
    expect(data).toEqual(expect.objectContaining({ target_ref: 'ORD-1', search_text: 'ord-1' }));
  });

  it('écriture impossible : rien ne remonte à l’appelant', async () => {
    const { service, create } = monter();
    create.mockRejectedValue(new Error('P1001'));

    expect(() => service.record(entree({ module: 'dishes', path: '/api/v1/dishes' }))).not.toThrow();
    await new Promise((r) => setImmediate(r));
    expect(create).toHaveBeenCalled();
  });
});

describe('AuditService.list : recherche', () => {
  const conditions = async (search?: string) => {
    const { service, prisma } = monter();
    await service.list({ view: 'actions', search });
    return JSON.stringify(prisma.auditLog.findMany.mock.calls[0][0].where);
  };

  it('une référence de commande ramène les lignes qui la portent', async () => {
    expect(await conditions('ORD-261128-00042')).toContain('{"search_text":{"contains":"ord-261128-00042"}}');
  });

  it('un numéro saisi avec des espaces et l’indicatif', async () => {
    expect(await conditions('+225 07 07 07 07 07')).toContain('{"search_text":{"contains":"0707070707"}}');
  });

  it('sans saisie : aucun filtre de recherche', async () => {
    expect(await conditions('  ')).not.toContain('search_text');
  });
});
