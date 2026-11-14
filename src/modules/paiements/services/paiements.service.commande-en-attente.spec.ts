/**
 * Paiement ajouté à la main sur une commande EN ATTENTE (14/11) : le webhook
 * n'a rien confirmé, l'équipe enregistre le paiement, la commande se confirme
 * (ACCEPTED, `accepted_at`) par le module des commandes.
 */
import { EntityStatus, OrderChannel, OrderStatus, PaiementMode, PaiementStatus, PaymentMethod, User, UserRole, UserType } from '@prisma/client';
import type { Request } from 'express';
import { PaiementChannels } from '../enums/paiement-channels';
import { PaiementsService } from './paiements.service';

const COMMANDE = '11111111-1111-4111-8111-111111111111';
const CLIENT = '44444444-4444-4444-8444-444444444444';
const ADMIN = { id: 'u-admin', type: UserType.BACKOFFICE, role: UserRole.ADMIN, restaurant_id: null } as unknown as User;
const CREEE_LE = new Date('2026-11-14T20:40:00.000Z');

/** Panier du site payé en ligne, resté en attente : le webhook n'est jamais arrivé. */
const panier = (surcharge: Record<string, unknown> = {}) => ({
  id: COMMANDE,
  reference: 'ORD-261114-23513',
  restaurant_id: 'r-zone4',
  customer_id: CLIENT,
  amount: 4040,
  auto: true,
  status: OrderStatus.PENDING,
  paied: false,
  paied_at: null,
  payment_method: PaymentMethod.ONLINE,
  channel: OrderChannel.WEB,
  entity_status: EntityStatus.ACTIVE,
  cancelled_by: null,
  created_at: CREEE_LE,
  submitted_at: null,
  ...surcharge,
});

function monter(commande: Record<string, unknown>, encaisse: number, issues: unknown[] = [true]) {
  const prisma = {
    order: {
      findUnique: jest
        .fn()
        // Contrôle avant l'encaissement, puis relecture avec les paiements.
        .mockResolvedValueOnce({ ...commande, paiements: [] })
        .mockResolvedValueOnce({ ...commande, paiements: [{ status: PaiementStatus.SUCCESS, amount: encaisse, total: encaisse }] }),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...commande, ...data })),
    },
  };
  const eventEmitter = { emit: jest.fn(), emitAsync: jest.fn().mockResolvedValue(issues) };
  const service = new PaiementsService(
    prisma as never,
    {} as never,
    {} as never,
    { activateUsageForOrder: jest.fn().mockResolvedValue(undefined) } as never,
    {} as never,
    eventEmitter as never,
    { signaler: jest.fn() } as never,
  );
  jest.spyOn(service, 'create').mockResolvedValue({ paiement: { id: 'p-1' }, order: null } as never);
  const encaisser = (montant: number) =>
    service.addPaiement({ user: ADMIN } as unknown as Request, {
      items: [{ amount: montant, mode: PaiementMode.MOBILE_MONEY, source: 'wave', order_id: COMMANDE }],
    } as never);
  return { service, prisma, eventEmitter, encaisser };
}

describe('POST /paiements/add : commande en attente', () => {
  it('soldée : payée, ramenée à l’instant du paiement, puis confirmée par le module des commandes', async () => {
    const { prisma, eventEmitter, encaisser } = monter(panier(), 4040);

    await expect(encaisser(4040)).resolves.toEqual({
      success: true,
      confirmee: true,
      message: 'Paiement enregistré : la commande est confirmée.',
    });

    const { data } = prisma.order.update.mock.calls[0][0];
    expect(data).toEqual(
      expect.objectContaining({ paied: true, paied_at: expect.any(Date), submitted_at: CREEE_LE, created_at: expect.any(Date) }),
    );
    // L'acceptation n'est pas écrite ici : elle passe par OrderService.updateStatus.
    expect(data.status).toBeUndefined();
    expect(eventEmitter.emitAsync).toHaveBeenCalledWith(PaiementChannels.COMMANDE_EN_ATTENTE_SOLDEE, {
      orderId: COMMANDE,
      etaitBrouillon: true,
      userId: ADMIN.id,
      role: UserRole.ADMIN,
    });
  });

  it('acceptation en échec : le paiement reste enregistré, la réponse le dit', async () => {
    const { encaisser } = monter(panier(), 4040, [false]);

    await expect(encaisser(4040)).resolves.toEqual({
      success: true,
      confirmee: false,
      message: 'Paiement effectué avec succès',
    });
  });

  it('paiement partiel : la commande reste en attente, aucune confirmation', async () => {
    const { prisma, eventEmitter, encaisser } = monter(panier(), 2000);

    const reponse = await encaisser(2000);

    expect(reponse).toEqual(expect.objectContaining({ success: true, confirmee: false }));
    expect(prisma.order.update.mock.calls[0][0].data).toEqual({});
    expect(eventEmitter.emitAsync).not.toHaveBeenCalled();
  });

  it('commande déjà acceptée : rien à confirmer', async () => {
    const { eventEmitter, encaisser } = monter(panier({ status: OrderStatus.READY, auto: false }), 4040);

    await expect(encaisser(4040)).resolves.toEqual(expect.objectContaining({ confirmee: false }));
    expect(eventEmitter.emitAsync).not.toHaveBeenCalled();
  });
});
