/**
 * Qui voit et relance les paniers non payés de l'application : ADMIN et
 * CALL_CENTER, sur CHAQUE route. Vraie garde, vrai Reflector, vrai contrôleur.
 *
 * Une permission ne suffirait pas : COMMANDES en lecture est aussi au
 * comptable, et la modification complète au gérant comme au caissier.
 */
import { ExecutionContext, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA, INTERCEPTORS_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { EntityStatus, OrderStatus, PaymentMethod, UserRole } from '@prisma/client';
import { USER_ROLES_KEY } from 'src/modules/auth/decorators/user-roles.decorator';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserRolesGuard } from 'src/modules/auth/guards/user-roles.guard';
import {
  ANNULEE_PAR_CLIENT,
  BROUILLON_WHERE,
  PANIER_ANNULE_PAR_CLIENT_WHERE,
  RELANCABLE_WHERE,
  ROLES_BROUILLONS,
  estBrouillon,
  estPanierAnnuleParClient,
  estRelancable,
  peutVoirLesBrouillons,
} from '../helpers/brouillons.rules';
import { OrderService } from '../services/order.service';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { IgnorerRelanceDto } from '../dto/ignorer-relance.dto';
import { OrderModule } from '../order.module';
import { correspond } from '../relance/relance.base-simulee-spec';
import { OrderController } from './order.controller';
import { OrderRelanceController } from './order-relance.controller';

const ROUTES: [string, (...args: never[]) => unknown][] = [
  ['GET /orders/relances', OrderRelanceController.prototype.lister],
  ['GET /orders/relances/ignorees', OrderRelanceController.prototype.listerIgnorees],
  ['POST /orders/relances/:orderId/prendre', OrderRelanceController.prototype.prendre],
  ['POST /orders/relances/:orderId/liberer', OrderRelanceController.prototype.liberer],
  ['POST /orders/relances/:orderId/ignorer', OrderRelanceController.prototype.ignorer],
  ['POST /orders/relances/:orderId/retablir', OrderRelanceController.prototype.retablir],
];

const garde = new UserRolesGuard(new Reflector());
function autorise(role: UserRole, route: (...args: never[]) => unknown): boolean {
  const contexte = {
    getHandler: () => route,
    getClass: () => OrderRelanceController,
    switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
  } as unknown as ExecutionContext;
  return garde.canActivate(contexte);
}

describe('Relance des paniers : droits', () => {
  it('toutes les méthodes du contrôleur sont listées ici', () => {
    const methodes = Object.getOwnPropertyNames(OrderRelanceController.prototype).filter((m) => m !== 'constructor');
    expect(methodes.sort()).toEqual(['ignorer', 'liberer', 'lister', 'listerIgnorees', 'prendre', 'retablir']);
  });

  it.each(ROUTES)('%s : jeton puis rôle, sur la méthode elle-même', (_route, methode) => {
    expect(Reflect.getMetadata(GUARDS_METADATA, methode)).toEqual([JwtAuthGuard, UserRolesGuard]);
    expect(Reflect.getMetadata(USER_ROLES_KEY, methode)).toEqual([UserRole.ADMIN, UserRole.CALL_CENTER]);
  });

  it.each(ROUTES)('%s : ouverte à ADMIN et CALL_CENTER', (_route, methode) => {
    expect(autorise(UserRole.ADMIN, methode)).toBe(true);
    expect(autorise(UserRole.CALL_CENTER, methode)).toBe(true);
  });

  it.each(ROUTES)('%s : refusée à tout autre rôle', (_route, methode) => {
    for (const role of [
      UserRole.MARKETING,
      UserRole.COMPTABLE,
      UserRole.MANAGER,
      UserRole.ASSISTANT_MANAGER,
      UserRole.CAISSIER,
      UserRole.CUISINE,
    ]) {
      expect(autorise(role, methode)).toBe(false);
    }
  });

  it("sans le cache par utilisateur : sa clé ignore le rôle", () => {
    expect(Reflect.getMetadata(INTERCEPTORS_METADATA, OrderRelanceController)).toBeUndefined();
    for (const [, methode] of ROUTES) {
      expect(Reflect.getMetadata(INTERCEPTORS_METADATA, methode)).toBeUndefined();
    }
  });

  it('déclaré avant le contrôleur des commandes (sinon `orders/:id` capterait `orders/relances`)', () => {
    const controleurs: unknown[] = Reflect.getMetadata('controllers', OrderModule);
    expect(controleurs.indexOf(OrderRelanceController)).toBeGreaterThanOrEqual(0);
    expect(controleurs.indexOf(OrderRelanceController)).toBeLessThan(controleurs.indexOf(OrderController));
  });

  it.each(ROUTES.filter(([route]) => route.includes(':orderId')))(
    '%s : un identifiant illisible répond « Commande introuvable. » (404)',
    async (_route, methode) => {
      const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, OrderRelanceController, methode.name) as Record<
        string,
        { pipes?: { transform: (v: string, m: unknown) => Promise<string> }[] }
      >;
      const tuyaux = Object.values(args).flatMap((a) => a.pipes ?? []);
      expect(tuyaux).toHaveLength(1);
      await expect(tuyaux[0].transform('pas-un-uuid', { type: 'param' })).rejects.toThrow(
        new NotFoundException('Commande introuvable.'),
      );
      await expect(
        tuyaux[0].transform('11111111-1111-4111-8111-111111111111', { type: 'param' }),
      ).resolves.toBe('11111111-1111-4111-8111-111111111111');
    },
  );
});

describe('Règle unique des brouillons', () => {
  it('ROLES_BROUILLONS et peutVoirLesBrouillons disent la même chose', () => {
    expect([...ROLES_BROUILLONS]).toEqual([UserRole.ADMIN, UserRole.CALL_CENTER]);
    for (const role of Object.values(UserRole)) {
      expect(peutVoirLesBrouillons({ role })).toBe((ROLES_BROUILLONS as readonly string[]).includes(role));
    }
    expect(peutVoirLesBrouillons(undefined)).toBe(false);
    expect(peutVoirLesBrouillons({ role: null })).toBe(false);
  });

  it('estBrouillon et BROUILLON_WHERE donnent le même verdict sur toutes les combinaisons', () => {
    let brouillons = 0;
    for (const auto of [true, false])
      for (const status of Object.values(OrderStatus))
        for (const paied of [true, false])
          for (const payment_method of Object.values(PaymentMethod))
            for (const entity_status of Object.values(EntityStatus)) {
              const commande = { auto, status, paied, payment_method, entity_status };
              const attendu = correspond(commande, BROUILLON_WHERE);
              expect({ commande, verdict: estBrouillon(commande) }).toEqual({ commande, verdict: attendu });
              if (attendu) brouillons += 1;
            }
    // Un seul cas : application, en attente, non payée, en ligne, non supprimée
    // (ACTIVE ou INACTIVE).
    expect(brouillons).toBe(Object.values(EntityStatus).length - 1);
  });

  it('estPanierAnnuleParClient, estRelancable et leurs `where` donnent le même verdict sur toutes les combinaisons', () => {
    let annules = 0;
    for (const auto of [true, false])
      for (const status of Object.values(OrderStatus))
        for (const paied of [true, false])
          for (const payment_method of Object.values(PaymentMethod))
            for (const entity_status of Object.values(EntityStatus))
              for (const cancelled_by of [ANNULEE_PAR_CLIENT, 'id-du-client', 'id-agent', null]) {
                const commande = { auto, status, paied, payment_method, entity_status, cancelled_by };
                const attendu = correspond(commande, PANIER_ANNULE_PAR_CLIENT_WHERE);
                expect({ commande, verdict: estPanierAnnuleParClient(commande) }).toEqual({ commande, verdict: attendu });
                expect({ commande, verdict: estRelancable(commande) }).toEqual({
                  commande,
                  verdict: correspond(commande, RELANCABLE_WHERE),
                });
                // Jamais les deux à la fois : un brouillon n'est jamais supprimé.
                if (attendu) expect(estBrouillon(commande)).toBe(false);
                if (attendu) annules += 1;
              }
    // Un seul cas : application, annulée, non payée, en ligne, supprimée, par le client.
    expect(annules).toBe(1);
  });
});

/**
 * GET /orders/:id : un panier annulé par le client (supprimé des listes) se lit
 * par ADMIN et CALL_CENTER, qui l'ouvrent depuis « À relancer ». Introuvable
 * pour les autres rôles, comme toute commande supprimée. Vraie méthode du
 * service, `where` évalué contre la commande comme le ferait la base.
 */
describe('GET /orders/:id : panier annulé par le client', () => {
  const ID = '11111111-1111-4111-8111-111111111111';
  const panierAnnule = {
    id: ID,
    restaurant_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    auto: true,
    status: OrderStatus.CANCELLED,
    paied: false,
    payment_method: PaymentMethod.ONLINE,
    entity_status: EntityStatus.DELETED,
    cancelled_by: ANNULEE_PAR_CLIENT,
    updated_by: null,
  };

  function monter(enBase: Record<string, unknown>) {
    const service = Object.create(OrderService.prototype) as OrderService;
    const findFirst = jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
      correspond(enBase, where) ? { ...enBase } : null,
    );
    Object.assign(service, { prisma: { order: { findFirst }, user: { findUnique: jest.fn() } } });
    const controleur = new OrderController({} as never, service, {} as never, {} as never, {} as never);
    const lire = (role: UserRole) =>
      controleur.findOne({ user: { id: 'u1', role, type: 'BACKOFFICE', restaurant_id: null } } as never, ID);
    return { lire, findFirst };
  }

  it('ADMIN et CALL_CENTER le lisent', async () => {
    const { lire } = monter(panierAnnule);
    for (const role of [UserRole.ADMIN, UserRole.CALL_CENTER]) {
      await expect(lire(role)).resolves.toEqual(expect.objectContaining({ id: ID, entity_status: EntityStatus.DELETED }));
    }
  });

  it('introuvable (404) pour tout autre rôle', async () => {
    const { lire } = monter(panierAnnule);
    for (const role of [UserRole.MARKETING, UserRole.COMPTABLE, UserRole.MANAGER, UserRole.CAISSIER, UserRole.CUISINE]) {
      await expect(lire(role)).rejects.toBeInstanceOf(NotFoundException);
    }
  });

  it('une autre commande supprimée reste introuvable pour tous, ADMIN compris', async () => {
    const autres = [
      { ...panierAnnule, cancelled_by: 'id-agent' }, // annulée par le personnel puis supprimée
      { ...panierAnnule, status: OrderStatus.PENDING, cancelled_by: null }, // supprimée au backoffice
      { ...panierAnnule, paied: true }, // payée
    ];
    for (const commande of autres) {
      const { lire } = monter(commande);
      await expect(lire(UserRole.ADMIN)).rejects.toBeInstanceOf(NotFoundException);
      await expect(lire(UserRole.CALL_CENTER)).rejects.toBeInstanceOf(NotFoundException);
    }
  });

  it('une commande active se lit comme avant, par tous', async () => {
    const { lire } = monter({ ...panierAnnule, entity_status: EntityStatus.ACTIVE, cancelled_by: 'id-agent' });
    await expect(lire(UserRole.CAISSIER)).resolves.toEqual(expect.objectContaining({ id: ID }));
  });
});

describe('IgnorerRelanceDto', () => {
  const erreurs = async (corps: Record<string, unknown>) =>
    (await validate(plainToInstance(IgnorerRelanceDto, corps))).flatMap((e) => Object.values(e.constraints ?? {}));

  it('raison absente ou inconnue : « Choisissez une raison. »', async () => {
    expect(await erreurs({})).toEqual(['Choisissez une raison.']);
    expect(await erreurs({ raison_code: 'FLEMME' })).toEqual(['Choisissez une raison.']);
  });

  it('texte de 160 caractères au plus, espaces retirés', async () => {
    expect(await erreurs({ raison_code: 'AUTRE', raison_texte: 'x'.repeat(161) })).toEqual([
      'Précisez la raison en 160 caractères au plus.',
    ]);
    expect(await erreurs({ raison_code: 'AUTRE', raison_texte: `  ${'x'.repeat(160)}  ` })).toEqual([]);
    expect(await erreurs({ raison_code: 'DOUBLON' })).toEqual([]);
  });
});
