/**
 * Encaissement depuis la caisse et le back office : un compte de restaurant
 * n'encaisse que les commandes de SON restaurant, et aucune commande ne part
 * sur un socket avec de quoi écrire au téléphone du client.
 *
 * Si l'un de ces tests casse, relisez la faille avant de l'adapter : un compte
 * du restaurant A marquait payée et terminait la commande du restaurant B.
 */

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  EntityStatus,
  OrderStatus,
  PaiementMode,
  PaiementStatus,
  User,
  UserRole,
  UserType,
} from '@prisma/client';
import type { Request } from 'express';
import { OrderChannels } from 'src/modules/order/enums/order-channels';
import { CLIENT_COMMANDE_SELECT } from 'src/modules/order/constantes/client-commande.select';
import { CLES_IDENTIFIANTS_PUSH } from 'src/modules/order/helpers/identifiants-push.helper';
import { PaiementsService } from './paiements.service';

const COMMANDE = '11111111-1111-4111-8111-111111111111';
const PAIEMENT = '33333333-3333-4333-8333-333333333333';
const CLIENT = '44444444-4444-4444-8444-444444444444';
const AUTRE_CLIENT = '55555555-5555-4555-8555-555555555555';
const RESTAURANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RESTAURANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const compte = (type: UserType, role: UserRole, restaurant_id: string | null) =>
  ({ id: 'u1', type, role, restaurant_id }) as unknown as User;
const caissierA = compte(UserType.RESTAURANT, UserRole.CAISSIER, RESTAURANT_A);
const administrateur = compte(UserType.BACKOFFICE, UserRole.ADMIN, null);
const requete = (user: User) => ({ user }) as unknown as Request;

/** Réglages de notification tels qu'un `include` trop large les ramènerait. */
const reglages = () => ({
  customer_id: CLIENT,
  expo_push_token: 'ExponentPushToken[abc]',
  expo_push_token_revoked: 'ExponentPushToken[old]',
  onesignal_id: 'os-1',
  onesignal_subscription_id: 'os-sub-1',
});

function monter() {
  const prisma = {
    order: { findUnique: jest.fn(), update: jest.fn() },
    paiement: { findUnique: jest.fn(), updateMany: jest.fn() },
    notificationSetting: { findUnique: jest.fn() },
  };
  const promoCodeService = { activateUsageForOrder: jest.fn().mockResolvedValue(undefined) };
  const appGateway = {
    emitToUser: jest.fn(),
    emitToBackoffice: jest.fn(),
    emitToRestaurant: jest.fn(),
  };
  const eventEmitter = { emit: jest.fn() };
  const service = new PaiementsService(
    prisma as never,
    {} as never,
    {} as never,
    promoCodeService as never,
    appGateway as never,
    eventEmitter as never,
  );
  const creer = jest
    .spyOn(service, 'create')
    .mockResolvedValue({ paiement: { id: 'p-neuf' }, order: null } as never);
  return { service, prisma, appGateway, eventEmitter, creer };
}

/** Toutes les clés présentes, à toute profondeur. */
function toutesLesCles(valeur: unknown, cles = new Set<string>()): Set<string> {
  if (Array.isArray(valeur)) {
    valeur.forEach((v) => toutesLesCles(v, cles));
  } else if (valeur && typeof valeur === 'object' && !(valeur instanceof Date)) {
    for (const [cle, contenu] of Object.entries(valeur)) {
      cles.add(cle);
      toutesLesCles(contenu, cles);
    }
  }
  return cles;
}

describe('PaiementsService.addPaiement', () => {
  /** Première lecture (`select`) : la commande à contrôler ; seconde (`include`) : le cumul. */
  function commandeEnBase(
    prisma: ReturnType<typeof monter>['prisma'],
    restaurant_id: string,
    cumul: { montant: number; statut: OrderStatus; encaisse: number },
  ) {
    prisma.order.findUnique.mockImplementation((args: { select?: unknown }) =>
      Promise.resolve(
        args.select
          ? {
              id: COMMANDE,
              restaurant_id,
              customer_id: CLIENT,
              status: cumul.statut,
              entity_status: EntityStatus.ACTIVE,
            }
          : {
              id: COMMANDE,
              amount: cumul.montant,
              status: cumul.statut,
              paied_at: null,
              paiements: [{ total: cumul.encaisse, amount: cumul.encaisse }],
            },
      ),
    );
    prisma.order.update.mockResolvedValue({ id: COMMANDE, code_promo: null });
  }

  it("interdit à un caissier d'encaisser la commande d'un autre restaurant, avant toute écriture", async () => {
    const { service, prisma, creer } = monter();
    commandeEnBase(prisma, RESTAURANT_B, { montant: 8000, statut: OrderStatus.READY, encaisse: 0 });

    await expect(
      service.addPaiement(requete(caissierA), {
        items: [{ amount: 8000, mode: PaiementMode.CASH, order_id: COMMANDE }],
      }),
    ).rejects.toThrow(ForbiddenException);

    expect(creer).not.toHaveBeenCalled();
    expect(prisma.order.update).not.toHaveBeenCalled();
  });

  it('laisse le caissier encaisser SA commande, au nom du client de la commande', async () => {
    const { service, prisma, creer } = monter();
    commandeEnBase(prisma, RESTAURANT_A, { montant: 8000, statut: OrderStatus.COLLECTED, encaisse: 8000 });

    const reponse = await service.addPaiement(requete(caissierA), {
      items: [
        { amount: 8000, mode: PaiementMode.CASH, order_id: COMMANDE, client_id: AUTRE_CLIENT },
        { amount: 0, mode: PaiementMode.CASH, order_id: COMMANDE },
      ],
    });

    expect(reponse.success).toBe(true);
    // La ligne à zéro est ignorée, le client du corps aussi.
    expect(creer).toHaveBeenCalledTimes(1);
    expect(creer.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        amount: 8000,
        order_id: COMMANDE,
        client_id: CLIENT,
        status: PaiementStatus.SUCCESS,
      }),
    );
    expect(prisma.order.update.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ paied: true, status: OrderStatus.COMPLETED }),
    );
  });

  it('laisse le back office encaisser dans tout le réseau', async () => {
    const { service, prisma, creer } = monter();
    commandeEnBase(prisma, RESTAURANT_B, { montant: 8000, statut: OrderStatus.READY, encaisse: 8000 });

    await service.addPaiement(requete(administrateur), {
      items: [{ amount: 8000, mode: PaiementMode.CASH, order_id: COMMANDE }],
    });

    expect(creer).toHaveBeenCalledTimes(1);
  });

  it("ne rend pas payée une commande réglée à moitié et le dit", async () => {
    const { service, prisma } = monter();
    commandeEnBase(prisma, RESTAURANT_A, { montant: 8000, statut: OrderStatus.COLLECTED, encaisse: 4000 });

    const reponse = await service.addPaiement(requete(caissierA), {
      items: [{ amount: 4000, mode: PaiementMode.CASH, order_id: COMMANDE }],
    });

    const donnees = prisma.order.update.mock.calls[0][0].data;
    expect(donnees.paied).toBeUndefined();
    expect(donnees.status).toBeUndefined();
    expect(reponse.message).toContain('reste dû');
  });

  it("refuse un encaissement où rien n'est saisi alors qu'il reste un dû, sans rien écrire", async () => {
    const { service, prisma, creer } = monter();
    commandeEnBase(prisma, RESTAURANT_A, { montant: 8000, statut: OrderStatus.COLLECTED, encaisse: 0 });

    await expect(
      service.addPaiement(requete(caissierA), {
        items: [{ amount: 0, mode: PaiementMode.CASH, order_id: COMMANDE }],
      }),
    ).rejects.toThrow(BadRequestException);
    expect(creer).not.toHaveBeenCalled();
    expect(prisma.order.update).not.toHaveBeenCalled();
  });

  it('solde une commande à zéro franc réglée par une ligne à zéro', async () => {
    const { service, prisma, creer } = monter();
    commandeEnBase(prisma, RESTAURANT_A, { montant: 0, statut: OrderStatus.COLLECTED, encaisse: 0 });

    const reponse = await service.addPaiement(requete(caissierA), {
      items: [{ amount: 0, mode: PaiementMode.CASH, order_id: COMMANDE }],
    });
    expect(creer).not.toHaveBeenCalled();
    expect(prisma.order.update.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ paied: true, status: OrderStatus.COMPLETED }),
    );
    expect(reponse.message).toBe('Paiement effectué avec succès');
  });
});

describe('PaiementsService.confirmerEncaissement', () => {
  function paiementEnAttente(prisma: ReturnType<typeof monter>['prisma'], restaurant_id: string) {
    prisma.paiement.findUnique.mockResolvedValue({
      id: PAIEMENT,
      status: PaiementStatus.PENDING,
      order_id: COMMANDE,
      order: { status: OrderStatus.COLLECTED, restaurant_id },
    });
    prisma.paiement.updateMany.mockResolvedValue({ count: 1 });
    prisma.order.findUnique.mockResolvedValue({
      id: COMMANDE,
      amount: 8000,
      status: OrderStatus.COLLECTED,
      paied_at: null,
      paiements: [{ total: 8000, amount: 8000 }],
    });
    // Commande telle qu'un `include` trop large la rendrait : le filet doit tenir.
    prisma.order.update.mockResolvedValue({
      id: COMMANDE,
      customer_id: CLIENT,
      restaurant_id,
      status: OrderStatus.COMPLETED,
      recovery_code: '4821',
      code_promo: null,
      customer: { id: CLIENT, first_name: 'Awa', notification_settings: reglages() },
    });
    prisma.notificationSetting.findUnique.mockResolvedValue({ expo_push_token: 'ExponentPushToken[abc]' });
  }

  it("interdit à un caissier de confirmer l'encaissement d'un autre restaurant, avant tout claim", async () => {
    const { service, prisma } = monter();
    paiementEnAttente(prisma, RESTAURANT_B);

    await expect(service.confirmerEncaissement(requete(caissierA), PAIEMENT)).rejects.toThrow(
      ForbiddenException,
    );
    expect(prisma.paiement.updateMany).not.toHaveBeenCalled();
    expect(prisma.order.update).not.toHaveBeenCalled();
  });

  it('confirme pour son restaurant sans jamais diffuser un identifiant de notification', async () => {
    const { service, prisma, appGateway, eventEmitter } = monter();
    paiementEnAttente(prisma, RESTAURANT_A);

    const reponse = await service.confirmerEncaissement(requete(caissierA), PAIEMENT);
    expect(reponse.message).toBe('Encaissement confirmé, commande terminée.');

    // La commande relue ne demande plus les réglages de notification.
    const include = prisma.order.update.mock.calls[0][0].include;
    expect(include.customer).toEqual({ select: CLIENT_COMMANDE_SELECT });
    expect(Object.keys(CLIENT_COMMANDE_SELECT)).not.toContain('notification_settings');

    // Aucun socket ne porte de jeton, même si la lecture en ramenait un.
    const emissions = [
      ...appGateway.emitToUser.mock.calls.map((c) => c[3]),
      ...appGateway.emitToBackoffice.mock.calls.map((c) => c[1]),
      ...appGateway.emitToRestaurant.mock.calls.map((c) => c[2]),
    ];
    expect(emissions).toHaveLength(3);
    for (const charge of emissions) {
      const cles = toutesLesCles(charge);
      for (const interdite of CLES_IDENTIFIANTS_PUSH) expect(cles.has(interdite)).toBe(false);
    }
    // Le client garde son code de récupération, les diffusions ne l'ont pas.
    expect(appGateway.emitToUser.mock.calls[0][3].order.recovery_code).toBe('4821');
    expect(appGateway.emitToBackoffice.mock.calls[0][1].order.recovery_code).toBeUndefined();

    // La notification interne reçoit le jeton, relu à part.
    const [canal, evenement] = eventEmitter.emit.mock.calls[0];
    expect(canal).toBe(OrderChannels.ORDER_STATUS_UPDATED);
    expect(evenement.expo_token).toBe('ExponentPushToken[abc]');
  });
});
