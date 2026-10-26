/**
 * Code de retrait du client (`Order.recovery_code`, copié dans
 * `Delivery.delivery_pin`) dans les routes du PERSONNEL sur les commandes
 * (26/10) : rendu à l'administrateur et au call center seulement, comme
 * `code_client` de `GET /orders/:id/livraison` (order-livraison.spec.ts).
 *
 * Le tiroir d'une commande lit `GET /orders/:id` pour tous les rôles : la
 * caissière, la cuisine ou le suivi des livraisons y lisaient le code, et un
 * livreur à qui on le dicte valide la remise sans voir le client. Le client,
 * lui, garde son code sur sa propre route.
 */

import { Customer, OrderStatus, User, UserRole, UserType } from '@prisma/client';
import type { Request } from 'express';
import { resolveStaffType } from 'src/modules/users/helpers/staff-type.helper';
import { commandePourLePersonnel, sansCodeClient } from '../helpers/code-client.rules';
import { OrderController } from './order.controller';

const RESTAURANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CODE = '4821';

const commande = () => ({
  id: 'o1',
  reference: 'ORD-261026-00001',
  restaurant_id: RESTAURANT_A,
  customer_id: 'client-1',
  status: OrderStatus.IN_PROGRESS,
  recovery_code: CODE,
  order_items: [{ id: 'l1', quantity: 2 }],
  delivery: {
    id: 'd1',
    statut: 'IN_ROUTE',
    delivery_pin: CODE,
    course: { id: 'c1', reference: 'CRS-261026-00001' },
  },
});

/** Ce que reçoivent les rôles sans le droit : la même commande, sans le code nulle part. */
const commandeSansCode = () => {
  const { recovery_code: _code, delivery, ...reste } = commande();
  const { delivery_pin: _pin, ...livraison } = delivery;
  return { ...reste, delivery: livraison };
};

function monter() {
  const service = {
    findById: jest.fn(async () => commande()),
    findAll: jest.fn(async () => ({
      data: [commande(), { ...commande(), id: 'o2', recovery_code: '7310', delivery: null }],
      meta: { total: 2, page: 1, limit: 10, totalPages: 1 },
    })),
    create: jest.fn(async () => commande()),
    markPaidCash: jest.fn(async () => commande()),
    update: jest.fn(async () => commande()),
    updateStatus: jest.fn(async () => commande()),
    remove: jest.fn(async () => commande()),
  };
  const kkiapay = { getPublicPaymentConfig: jest.fn(async () => ({ publicKey: 'cle-publique', sandbox: true })) };
  const controleur = new OrderController(
    kkiapay as never,
    service as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { controleur, service };
}

/** Compte du rôle, du type que lui donne le serveur, rattaché au restaurant de la commande s'il en a un. */
function compte(role: UserRole): User {
  const type = resolveStaffType(role);
  return { id: `u-${role}`, role, type, restaurant_id: type === UserType.RESTAURANT ? RESTAURANT_A : null } as unknown as User;
}

const requete = (user: User | Customer) => ({ user }) as unknown as Request;

/** Chaque route du personnel qui rend une commande. */
const ROUTES: Record<string, (c: OrderController, user: User) => Promise<unknown>> = {
  'GET /orders/:id': (c, user) => c.findOne(requete(user), 'o1'),
  'POST /orders/create': (c, user) => c.createBackoffice(requete(user), { restaurant_id: RESTAURANT_A } as never),
  'POST /orders/:id/mark-paid-cash': (c, user) => c.markPaidCash(requete(user), 'o1', { amount: 5000 } as never),
  'PATCH /orders/:id': (c, user) => c.update(requete(user), 'o1', {} as never),
  'PATCH /orders/:id/status': (c, user) => c.updateStatus(requete(user), 'o1', { status: OrderStatus.READY }),
  'DELETE /orders/:id': (c, user) => c.remove(requete(user), 'o1'),
};

const AUTORISES: readonly UserRole[] = [UserRole.ADMIN, UserRole.CALL_CENTER];
const AUTRES = Object.values(UserRole).filter((role) => !AUTORISES.includes(role));

describe('Routes du personnel sur une commande : code de retrait du client', () => {
  describe.each(Object.keys(ROUTES))('%s', (route) => {
    it.each(AUTORISES)('%s : la commande telle quelle, code compris', async (role) => {
      const { controleur } = monter();
      await expect(ROUTES[route](controleur, compte(role))).resolves.toEqual(commande());
    });

    it.each(AUTRES)('%s : ni `recovery_code` ni `delivery.delivery_pin`, le reste inchangé', async (role) => {
      const { controleur } = monter();
      const reponse = (await ROUTES[route](controleur, compte(role))) as Record<string, any>;
      expect('recovery_code' in reponse).toBe(false);
      expect('delivery_pin' in reponse.delivery).toBe(false);
      expect(reponse).toEqual(commandeSansCode());
      expect(JSON.stringify(reponse)).not.toContain(CODE);
    });
  });
});

describe('GET /orders : code de retrait du client', () => {
  it.each(AUTORISES)('%s : chaque commande de la page garde son code', async (role) => {
    const { controleur } = monter();
    const page = await controleur.findAll(requete(compte(role)), {} as never);
    expect(page.data.map((c: any) => c.recovery_code)).toEqual([CODE, '7310']);
    expect(page.meta).toEqual({ total: 2, page: 1, limit: 10, totalPages: 1 });
  });

  it.each(AUTRES)('%s : aucune commande de la page ne porte le code, la pagination ne change pas', async (role) => {
    const { controleur, service } = monter();
    const page = await controleur.findAll(requete(compte(role)), {} as never);
    expect(page.data.map((c: any) => c.id)).toEqual(['o1', 'o2']);
    expect(page.data.every((c: any) => !('recovery_code' in c))).toBe(true);
    expect(JSON.stringify(page)).not.toContain(CODE);
    expect(JSON.stringify(page)).not.toContain('7310');
    expect(page.meta).toEqual({ total: 2, page: 1, limit: 10, totalPages: 1 });
    // Le filtrage des commandes en attente suit toujours le compte du jeton.
    expect(service.findAll).toHaveBeenCalledWith({}, compte(role));
  });
});

describe('Route du client : il garde son code', () => {
  it('GET /orders/:id/client rend `recovery_code` et `delivery_pin` au client de la commande', async () => {
    const { controleur } = monter();
    const reponse = (await controleur.findOneClient(requete({ id: 'client-1' } as Customer), 'o1')) as Record<string, any>;
    expect(reponse.recovery_code).toBe(CODE);
    expect(reponse.delivery.delivery_pin).toBe(CODE);
  });
});

describe('sansCodeClient', () => {
  it("rend une copie : l'original garde son code", () => {
    const original = commande();
    const copie = sansCodeClient(original);
    expect(copie).toEqual(commandeSansCode());
    expect(original.recovery_code).toBe(CODE);
    expect(original.delivery.delivery_pin).toBe(CODE);
  });

  it('commande sans livraison incluse, livraison absente, valeurs nulles : rendues sans erreur', () => {
    expect(sansCodeClient({ id: 'o1', recovery_code: CODE })).toEqual({ id: 'o1' });
    expect(sansCodeClient({ id: 'o1', recovery_code: null, delivery: null })).toEqual({ id: 'o1', delivery: null });
    expect(sansCodeClient(null)).toBeNull();
    expect(sansCodeClient(undefined)).toBeUndefined();
  });

  it('compte absent ou sans rôle : sans le code', () => {
    expect(commandePourLePersonnel(undefined, commande())).toEqual(commandeSansCode());
    expect(commandePourLePersonnel({ role: null }, commande())).toEqual(commandeSansCode());
  });
});
