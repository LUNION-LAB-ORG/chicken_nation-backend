/**
 * Qui peut appliquer une réduction à la prise de commande, et avec quel
 * auteur : vraie garde, vraie table des droits, vrais contrôleurs.
 *
 * Décision du 25/09 : ADMIN, CALL_CENTER et CAISSIER (COMMANDES CREATE),
 * chaque usage journalisé avec l'agent.
 */
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { OrderStatus, User, UserRole, UserType } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { Request } from 'express';
import { REQUIRE_PERMISSION_KEY } from 'src/modules/auth/decorators/user-require-permission';
import { Action } from 'src/modules/auth/enums/action.enum';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { CreateOrderDto } from '../dto/create-order.dto';
import { CouponCreationThrottlerGuard, CouponThrottlerGuard, LIMITE_COUPON } from '../guards/coupon-throttler.guard';
import { OrderCouponController } from './order-coupon.controller';
import { OrderController } from './order.controller';
import { OrderModule } from '../order.module';

const ROUTES: [string, (...args: never[]) => unknown][] = [
  ['POST /orders/coupon/apercu', OrderCouponController.prototype.apercu],
  ['GET /orders/coupon/bons-client/:customerId', OrderCouponController.prototype.bonsClient],
];

const garde = new UserPermissionsGuard(new Reflector());
function autorise(role: UserRole, route: (...args: never[]) => unknown): boolean {
  const contexte = {
    getHandler: () => route,
    switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
  } as unknown as ExecutionContext;
  return garde.canActivate(contexte);
}

describe('Réductions : droits', () => {
  it.each(ROUTES)('%s exige COMMANDES CREATE', (_route, methode) => {
    expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, methode)).toEqual({
      module: Modules.COMMANDES,
      action: Action.CREATE,
    });
  });

  it.each(ROUTES)('%s est ouvert à ADMIN, CALL_CENTER et CAISSIER', (_route, methode) => {
    for (const role of [UserRole.ADMIN, UserRole.CALL_CENTER, UserRole.CAISSIER]) {
      expect(autorise(role, methode)).toBe(true);
    }
  });

  it.each(ROUTES)('%s est refusé aux autres rôles', (_route, methode) => {
    for (const role of [
      UserRole.MANAGER,
      UserRole.ASSISTANT_MANAGER,
      UserRole.CUISINE,
      UserRole.MARKETING,
      UserRole.COMPTABLE,
    ]) {
      expect(autorise(role, methode)).toBe(false);
    }
  });

  it('jeton, droit, PUIS limite par agent, dans cet ordre', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, OrderCouponController)).toEqual([
      JwtAuthGuard,
      UserPermissionsGuard,
      CouponThrottlerGuard,
    ]);
  });

  it.each(ROUTES)('%s est limitée à 30 appels par minute', (_route, methode) => {
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', methode)).toBe(LIMITE_COUPON.default.limit);
    expect(Reflect.getMetadata('THROTTLER:TTLdefault', methode)).toBe(LIMITE_COUPON.default.ttl);
  });

  it("compte les appels par agent, pas par adresse IP (un centre d'appel partage son adresse)", async () => {
    const guardeDebit = Object.create(CouponThrottlerGuard.prototype) as CouponThrottlerGuard;
    const suivi = (req: Record<string, unknown>) =>
      (guardeDebit as unknown as { getTracker(r: unknown): Promise<string> }).getTracker(req);
    await expect(suivi({ user: { id: 'agent-1' }, ip: '1.2.3.4' })).resolves.toBe('agent:agent-1');
    await expect(suivi({ user: { id: 'agent-2' }, ip: '1.2.3.4' })).resolves.toBe('agent:agent-2');
  });

  it('le contrôleur des réductions est déclaré avant celui des commandes', () => {
    const controleurs: unknown[] = Reflect.getMetadata('controllers', OrderModule);
    expect(controleurs.indexOf(OrderCouponController)).toBeLessThan(controleurs.indexOf(OrderController));
  });
});

describe('POST /orders/create : auteur et restaurant pris du jeton', () => {
  const RESTAURANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const RESTAURANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  function creer(user: Partial<User>, corps: Partial<CreateOrderDto>) {
    const orderService = { create: jest.fn().mockResolvedValue({ id: 'o1' }) };
    const controleur = new OrderController({} as never, orderService as never, {} as never, {} as never, {} as never);
    const req = { user } as unknown as Request;
    return { appel: controleur.createBackoffice(req, corps as CreateOrderDto), orderService };
  }

  it("ignore l'auteur annoncé dans le corps", async () => {
    const { appel, orderService } = creer(
      { id: 'agent-1', type: UserType.BACKOFFICE, role: UserRole.CALL_CENTER },
      { user_id: 'quelqu-un-d-autre', restaurant_id: RESTAURANT_B },
    );
    await appel;
    expect(orderService.create.mock.calls[0][1]).toEqual(
      expect.objectContaining({ user_id: 'agent-1', restaurant_id: RESTAURANT_B }),
    );
  });

  it('pose le restaurant du caissier quand le corps ne le donne pas', async () => {
    const { appel, orderService } = creer(
      { id: 'caisse-1', type: UserType.RESTAURANT, role: UserRole.CAISSIER, restaurant_id: RESTAURANT_A },
      {},
    );
    await appel;
    expect(orderService.create.mock.calls[0][1]).toEqual(
      expect.objectContaining({ user_id: 'caisse-1', restaurant_id: RESTAURANT_A }),
    );
  });

  it("refuse au caissier une commande pour un autre restaurant", async () => {
    const { appel, orderService } = creer(
      { id: 'caisse-1', type: UserType.RESTAURANT, role: UserRole.CAISSIER, restaurant_id: RESTAURANT_A },
      { restaurant_id: RESTAURANT_B },
    );
    await expect(appel).rejects.toThrow(ForbiddenException);
    expect(orderService.create).not.toHaveBeenCalled();
  });
});

describe('POST /orders (route client historique)', () => {
  it("n'accepte plus de code : il était enregistré sans aucune remise", async () => {
    const orderService = { create: jest.fn().mockResolvedValue({ id: 'o1' }) };
    const controleur = new OrderController({} as never, orderService as never, {} as never, {} as never, {} as never);
    await controleur.create({ user: { id: 'client-1' } } as unknown as Request, {
      code_promo: 'BIENVENUE20',
      items: [],
    } as unknown as CreateOrderDto);
    expect(orderService.create.mock.calls[0][1].code_promo).toBeUndefined();
  });
});

describe('POST /orders/create : quota des codes essayés', () => {
  it('porte la garde de quota, après le jeton et le droit, avec la même limite que l’aperçu', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, OrderController.prototype.createBackoffice)).toEqual([
      JwtAuthGuard,
      UserPermissionsGuard,
      CouponCreationThrottlerGuard,
    ]);
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', OrderController.prototype.createBackoffice)).toBe(
      LIMITE_COUPON.default.limit,
    );
  });

  it("ne compte que les commandes qui portent un code : les autres ne sont jamais freinées", async () => {
    const garde = Object.create(CouponCreationThrottlerGuard.prototype) as CouponCreationThrottlerGuard;
    const ignore = (body: unknown) =>
      (garde as unknown as { shouldSkip(c: unknown): Promise<boolean> }).shouldSkip({
        switchToHttp: () => ({ getRequest: () => ({ body, user: { id: 'agent-1' } }) }),
      });
    await expect(ignore({ items: [] })).resolves.toBe(true);
    await expect(ignore({ code_promo: '   ' })).resolves.toBe(true);
    await expect(ignore({ code_promo: 'BIENVENUE20' })).resolves.toBe(false);
  });
});

describe('Routes du client : rien qui touche aux réductions', () => {
  const commande = { id: 'o1', customer_id: 'client-1' };
  function controleur() {
    const orderService = {
      findById: jest.fn().mockResolvedValue(commande),
      updateStatus: jest.fn().mockResolvedValue({ id: 'o1' }),
      updateClient: jest.fn().mockResolvedValue({ id: 'o1' }),
    };
    const c = new OrderController({} as never, orderService as never, {} as never, {} as never, {} as never);
    return { c, orderService, req: { user: { id: 'client-1' } } as unknown as Request };
  }

  it("l'annulation par le client ne reprend que le motif : « role: ADMIN » n'ouvre plus l'annulation d'une commande livrée", async () => {
    const { c, orderService, req } = controleur();
    await c.updateStatusClient(req, 'o1', {
      status: OrderStatus.CANCELLED,
      meta: { reason: 'Trop long', role: UserRole.ADMIN, _voucher: { code: 'FAUX' }, userId: 'autre' },
    });
    expect(orderService.updateStatus).toHaveBeenCalledWith('o1', OrderStatus.CANCELLED, {
      reason: 'Trop long',
      userId: 'client-1',
    });
  });

  it("la modification par le client n'écrit jamais de code promo sur la commande", async () => {
    const { c, orderService, req } = controleur();
    await c.updateClient(req, 'o1', { code_promo: 'CN-ABCDEF', note: 'Sonner deux fois' } as never);
    const champs = orderService.updateClient.mock.calls[0][1];
    expect(champs).not.toHaveProperty('code_promo');
    expect(champs).toEqual({ note: 'Sonner deux fois' });
  });
});

describe('Frais de livraison imposés', () => {
  it('refuse un frais négatif, qui faisait passer le total sous zéro', async () => {
    const dto = plainToInstance(CreateOrderDto, {
      type: 'PICKUP',
      items: [{ dish_id: '66666666-6666-4666-8666-666666666666', quantity: 1 }],
      delivery_fee: -5000,
    });
    const erreurs = await validate(dto);
    const frais = erreurs.find((e) => e.property === 'delivery_fee');
    expect(Object.values(frais?.constraints ?? {})).toContain('Les frais de livraison ne peuvent pas être négatifs.');
  });

  it('accepte 0 (livraison offerte imposée à la main)', async () => {
    const dto = plainToInstance(CreateOrderDto, {
      type: 'PICKUP',
      items: [{ dish_id: '66666666-6666-4666-8666-666666666666', quantity: 1 }],
      delivery_fee: 0,
    });
    const erreurs = await validate(dto);
    expect(erreurs.find((e) => e.property === 'delivery_fee')).toBeUndefined();
  });
});
