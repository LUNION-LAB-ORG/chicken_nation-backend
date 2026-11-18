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
    paiement: {
      findUnique: jest.fn(),
      updateMany: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'p-neuf', ...data })),
    },
    notificationSetting: { findUnique: jest.fn() },
    // Verrou de la commande (18/11) : la transaction rejoue le même client.
    $queryRaw: jest.fn().mockResolvedValue([]),
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((travail: (tx: typeof prisma) => unknown) => travail(prisma));
  const promoCodeService = { activateUsageForOrder: jest.fn().mockResolvedValue(undefined) };
  const appGateway = {
    emitToUser: jest.fn(),
    emitToBackoffice: jest.fn(),
    emitToRestaurant: jest.fn(),
  };
  const eventEmitter = { emit: jest.fn() };
  const paiementEvent = { paiementEffectue: jest.fn(), paiementAnnule: jest.fn() };
  const service = new PaiementsService(
    prisma as never,
    {} as never,
    paiementEvent as never,
    promoCodeService as never,
    appGateway as never,
    eventEmitter as never,
    { signaler: jest.fn() } as never,
  );
  const creer = prisma.paiement.create;
  return { service, prisma, appGateway, eventEmitter, creer, paiementEvent };
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
    expect(creer.mock.calls[0][0].data).toEqual(
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

  it("refuse d'encaisser une commande déjà soldée, sans rien écrire", async () => {
    // Le client a fini de payer dans l'application pendant que la caisse,
    // sur un écran pas encore rafraîchi, encaissait au comptoir.
    const { service, prisma, creer } = monter();
    prisma.order.findUnique.mockResolvedValue({
      id: COMMANDE,
      restaurant_id: RESTAURANT_A,
      customer_id: CLIENT,
      status: OrderStatus.READY,
      entity_status: EntityStatus.ACTIVE,
      amount: 8000,
      paiements: [{ status: PaiementStatus.SUCCESS, total: 8000, amount: 8000 }],
    });

    await expect(
      service.addPaiement(requete(caissierA), {
        items: [{ amount: 8000, mode: PaiementMode.CASH, order_id: COMMANDE }],
      }),
    ).rejects.toThrow('Commande déjà payée.');
    expect(creer).not.toHaveBeenCalled();
    expect(prisma.order.update).not.toHaveBeenCalled();
  });

  it('laisse encaisser le reste d\'une commande payée en partie', async () => {
    const { service, prisma, creer } = monter();
    prisma.order.findUnique.mockResolvedValueOnce({
      id: COMMANDE,
      restaurant_id: RESTAURANT_A,
      customer_id: CLIENT,
      status: OrderStatus.READY,
      entity_status: EntityStatus.ACTIVE,
      amount: 8000,
      paiements: [{ status: PaiementStatus.SUCCESS, total: 3000, amount: 3000 }],
    });
    prisma.order.findUnique.mockResolvedValueOnce({
      id: COMMANDE,
      amount: 8000,
      status: OrderStatus.READY,
      paied_at: null,
      paiements: [{ total: 3000, amount: 3000 }, { total: 5000, amount: 5000 }],
    });
    prisma.order.update.mockResolvedValue({ id: COMMANDE, code_promo: null });

    const reponse = await service.addPaiement(requete(caissierA), {
      items: [{ amount: 5000, mode: PaiementMode.CASH, order_id: COMMANDE }],
    });

    expect(creer).toHaveBeenCalledTimes(1);
    expect(prisma.order.update.mock.calls[0][0].data).toEqual(expect.objectContaining({ paied: true }));
    expect(reponse.message).toBe('Paiement effectué avec succès');
  });
});

describe('PaiementsService.addPaiement : paiements de trop (18/11)', () => {
  /** Commande lue sous le verrou : réussis ET en attente. */
  function commandeSousVerrou(
    prisma: ReturnType<typeof monter>['prisma'],
    paiements: { status: PaiementStatus; amount: number; total?: number }[],
    montant = 10000,
  ) {
    prisma.order.findUnique.mockImplementation((args: { select?: unknown }) =>
      Promise.resolve(
        args.select
          ? {
              id: COMMANDE,
              restaurant_id: RESTAURANT_A,
              customer_id: CLIENT,
              status: OrderStatus.READY,
              entity_status: EntityStatus.ACTIVE,
              amount: montant,
              paiements: paiements.map((p) => ({ total: p.amount, ...p })),
            }
          : {
              id: COMMANDE,
              amount: montant,
              status: OrderStatus.READY,
              paied_at: null,
              paiements: [{ total: montant, amount: montant }],
            },
      ),
    );
    prisma.order.update.mockResolvedValue({ id: COMMANDE, code_promo: null });
  }

  it('refuse 15 000 sur une commande à 10 000, sans rien écrire', async () => {
    const { service, prisma, creer, paiementEvent } = monter();
    commandeSousVerrou(prisma, []);

    await expect(
      service.addPaiement(requete(caissierA), {
        items: [{ amount: 15000, mode: PaiementMode.CASH, order_id: COMMANDE }],
      }),
    ).rejects.toThrow(/^Paiement de trop/);
    expect(creer).not.toHaveBeenCalled();
    expect(paiementEvent.paiementEffectue).not.toHaveBeenCalled();
    expect(prisma.order.update).not.toHaveBeenCalled();
  });

  it('refuse aussi un paiement partagé dont la somme dépasse le prix', async () => {
    const { service, prisma, creer } = monter();
    commandeSousVerrou(prisma, []);

    await expect(
      service.addPaiement(requete(caissierA), {
        items: [
          { amount: 6000, mode: PaiementMode.CASH, order_id: COMMANDE },
          { amount: 6000, mode: PaiementMode.MOBILE_MONEY, source: 'wave', order_id: COMMANDE },
        ],
      }),
    ).rejects.toThrow(/^Paiement de trop/);
    expect(creer).not.toHaveBeenCalled();
  });

  it("refuse d'encaisser ce que le livreur a déjà déclaré : il faut d'abord confirmer ou refuser", async () => {
    const { service, prisma, creer } = monter();
    commandeSousVerrou(prisma, [{ status: PaiementStatus.PENDING, amount: 10000 }]);

    await expect(
      service.addPaiement(requete(caissierA), {
        items: [{ amount: 10000, mode: PaiementMode.CASH, order_id: COMMANDE }],
      }),
    ).rejects.toThrow(/^Le livreur a déjà déclaré/);
    expect(creer).not.toHaveBeenCalled();
  });

  it('laisse encaisser ce que la déclaration partielle du livreur ne couvre pas', async () => {
    const { service, prisma, creer } = monter();
    commandeSousVerrou(prisma, [{ status: PaiementStatus.PENDING, amount: 6000 }]);

    await service.addPaiement(requete(caissierA), {
      items: [{ amount: 4000, mode: PaiementMode.CASH, order_id: COMMANDE }],
    });
    expect(creer).toHaveBeenCalledTimes(1);
  });

  it('verrouille la commande AVANT de la lire : deux postes au même instant ne passent pas tous les deux', async () => {
    const { service, prisma } = monter();
    commandeSousVerrou(prisma, []);

    await service.addPaiement(requete(caissierA), {
      items: [{ amount: 10000, mode: PaiementMode.CASH, order_id: COMMANDE }],
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const verrou = prisma.$queryRaw.mock.invocationCallOrder[0];
    const lecture = prisma.order.findUnique.mock.invocationCallOrder[0];
    expect(verrou).toBeLessThan(lecture);
    expect(prisma.$queryRaw.mock.calls[0][0].join('')).toContain('FOR UPDATE');
  });

  it("n'annonce les paiements qu'une fois tout le lot écrit", async () => {
    const { service, prisma, creer, paiementEvent } = monter();
    commandeSousVerrou(prisma, []);
    creer
      .mockImplementationOnce(({ data }) => Promise.resolve({ id: 'p1', ...data }))
      .mockRejectedValueOnce(new Error('base indisponible'));

    await expect(
      service.addPaiement(requete(caissierA), {
        items: [
          { amount: 4000, mode: PaiementMode.CASH, order_id: COMMANDE },
          { amount: 6000, mode: PaiementMode.MOBILE_MONEY, source: 'wave', order_id: COMMANDE },
        ],
      }),
    ).rejects.toThrow('base indisponible');
    expect(paiementEvent.paiementEffectue).not.toHaveBeenCalled();
  });
});

describe('PaiementsService.confirmerEncaissement', () => {
  function paiementEnAttente(prisma: ReturnType<typeof monter>['prisma'], restaurant_id: string) {
    prisma.paiement.findUnique.mockResolvedValue({
      id: PAIEMENT,
      status: PaiementStatus.PENDING,
      amount: 8000,
      order_id: COMMANDE,
      order: { status: OrderStatus.COLLECTED, restaurant_id, amount: 8000 },
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

describe('PaiementsService.confirmerEncaissement : paiements de trop (18/11)', () => {
  function declaration(prisma: ReturnType<typeof monter>['prisma'], declare: number, dejaRecu: number[]) {
    prisma.paiement.findUnique.mockResolvedValue({
      id: PAIEMENT,
      status: PaiementStatus.PENDING,
      amount: declare,
      order_id: COMMANDE,
      order: { status: OrderStatus.COLLECTED, restaurant_id: RESTAURANT_A, amount: 8000 },
    });
    prisma.paiement.findMany.mockResolvedValue(
      dejaRecu.map((amount) => ({ status: PaiementStatus.SUCCESS, amount })),
    );
    prisma.paiement.updateMany.mockResolvedValue({ count: 1 });
  }

  it('refuse de confirmer quand la caisse a déjà encaissé la commande, avant tout claim', async () => {
    const { service, prisma } = monter();
    declaration(prisma, 8000, [8000]);

    await expect(service.confirmerEncaissement(requete(caissierA), PAIEMENT)).rejects.toThrow(
      'Commande déjà payée : ce paiement serait de trop. Refusez-le.',
    );
    expect(prisma.paiement.updateMany).not.toHaveBeenCalled();
    expect(prisma.order.update).not.toHaveBeenCalled();
  });

  it('refuse une déclaration plus grosse que le reste', async () => {
    const { service, prisma } = monter();
    declaration(prisma, 8000, [3000]);

    await expect(service.confirmerEncaissement(requete(caissierA), PAIEMENT)).rejects.toThrow(
      /^Ce paiement dépasse ce qui reste à encaisser/,
    );
    expect(prisma.paiement.updateMany).not.toHaveBeenCalled();
  });

  it('contrôle et revendique sous le verrou de la commande', async () => {
    const { service, prisma } = monter();
    declaration(prisma, 5000, [3000]);
    prisma.order.findUnique.mockResolvedValue({
      id: COMMANDE,
      amount: 8000,
      status: OrderStatus.COLLECTED,
      paied_at: null,
      paiements: [{ total: 3000, amount: 3000 }, { total: 5000, amount: 5000 }],
    });
    prisma.order.update.mockResolvedValue({ id: COMMANDE, customer_id: CLIENT, restaurant_id: RESTAURANT_A, code_promo: null });
    prisma.notificationSetting.findUnique.mockResolvedValue(null);

    await service.confirmerEncaissement(requete(caissierA), PAIEMENT);
    const verrou = prisma.$queryRaw.mock.invocationCallOrder[0];
    expect(verrou).toBeLessThan(prisma.paiement.findMany.mock.invocationCallOrder[0]);
    expect(verrou).toBeLessThan(prisma.paiement.updateMany.mock.invocationCallOrder[0]);
  });

  it("ne dit pas « déjà confirmé » d'un encaissement qu'un autre poste vient de refuser", async () => {
    const { service, prisma } = monter();
    declaration(prisma, 8000, []);
    prisma.paiement.updateMany.mockResolvedValue({ count: 0 });
    prisma.paiement.findUnique
      .mockResolvedValueOnce({
        id: PAIEMENT,
        status: PaiementStatus.PENDING,
        amount: 8000,
        order_id: COMMANDE,
        order: { status: OrderStatus.COLLECTED, restaurant_id: RESTAURANT_A, amount: 8000 },
      })
      .mockResolvedValueOnce({ status: PaiementStatus.FAILED });

    await expect(service.confirmerEncaissement(requete(caissierA), PAIEMENT)).rejects.toThrow(/vient d'être refusé/);
    expect(prisma.order.update).not.toHaveBeenCalled();
  });

  it('refuse de confirmer une déclaration déjà refusée', async () => {
    const { service, prisma } = monter();
    prisma.paiement.findUnique.mockResolvedValue({
      id: PAIEMENT,
      status: PaiementStatus.FAILED,
      amount: 8000,
      order_id: COMMANDE,
      order: { status: OrderStatus.COLLECTED, restaurant_id: RESTAURANT_A, amount: 8000 },
    });

    await expect(service.confirmerEncaissement(requete(caissierA), PAIEMENT)).rejects.toThrow(/a été refusé/);
    expect(prisma.paiement.updateMany).not.toHaveBeenCalled();
  });
});

describe('PaiementsService.refuserEncaissement (18/11)', () => {
  const caissiereNommee = { ...caissierA, fullname: 'Awa Koné' } as unknown as User;

  function enAttente(prisma: ReturnType<typeof monter>['prisma'], restaurant_id: string, status = PaiementStatus.PENDING as PaiementStatus) {
    prisma.paiement.findUnique.mockResolvedValue({ id: PAIEMENT, status, order: { restaurant_id } });
    prisma.paiement.updateMany.mockResolvedValue({ count: 1 });
  }

  it("interdit à un caissier de refuser l'encaissement d'un autre restaurant, avant toute écriture", async () => {
    const { service, prisma } = monter();
    enAttente(prisma, RESTAURANT_B);

    await expect(service.refuserEncaissement(requete(caissiereNommee), PAIEMENT)).rejects.toThrow(ForbiddenException);
    expect(prisma.paiement.updateMany).not.toHaveBeenCalled();
  });

  it("passe la déclaration en échec, avec le motif et le nom de qui l'a refusée, sans toucher la commande", async () => {
    const { service, prisma } = monter();
    enAttente(prisma, RESTAURANT_A);

    const reponse = await service.refuserEncaissement(requete(caissiereNommee), PAIEMENT);

    expect(reponse).toEqual({ success: true, message: 'Encaissement refusé.' });
    const [{ where, data }] = prisma.paiement.updateMany.mock.calls[0];
    expect(where).toEqual({ id: PAIEMENT, status: PaiementStatus.PENDING });
    expect(data).toEqual(
      expect.objectContaining({
        status: PaiementStatus.FAILED,
        failure_code: 'REFUSE_PAR_LE_RESTAURANT',
        failure_message: 'Refusé par Awa Koné',
      }),
    );
    expect(prisma.order.update).not.toHaveBeenCalled();
  });

  it('répond sans rien écrire quand la déclaration est déjà refusée (double clic)', async () => {
    const { service, prisma } = monter();
    enAttente(prisma, RESTAURANT_A, PaiementStatus.FAILED);

    await expect(service.refuserEncaissement(requete(caissiereNommee), PAIEMENT)).resolves.toEqual(
      expect.objectContaining({ message: 'Encaissement déjà refusé.' }),
    );
    expect(prisma.paiement.updateMany).not.toHaveBeenCalled();
  });

  it('refuse de défaire un paiement réussi : seule une déclaration en attente se refuse', async () => {
    const { service, prisma } = monter();
    enAttente(prisma, RESTAURANT_A, PaiementStatus.SUCCESS);

    await expect(service.refuserEncaissement(requete(caissiereNommee), PAIEMENT)).rejects.toThrow(BadRequestException);
    expect(prisma.paiement.updateMany).not.toHaveBeenCalled();
  });

  it('le dit quand un autre poste vient de la confirmer', async () => {
    const { service, prisma } = monter();
    enAttente(prisma, RESTAURANT_A);
    prisma.paiement.updateMany.mockResolvedValue({ count: 0 });
    prisma.paiement.findUnique
      .mockResolvedValueOnce({ id: PAIEMENT, status: PaiementStatus.PENDING, order: { restaurant_id: RESTAURANT_A } })
      .mockResolvedValueOnce({ status: PaiementStatus.SUCCESS });

    await expect(service.refuserEncaissement(requete(caissiereNommee), PAIEMENT)).rejects.toThrow(/vient d'être confirmé/);
  });
});

describe('PaiementsService.update : correction par l’administrateur (18/11)', () => {
  function paiementReussi(prisma: ReturnType<typeof monter>['prisma'], amount: number, autres: number[]) {
    prisma.paiement.findUnique.mockResolvedValue({
      id: PAIEMENT,
      amount,
      fees: 0,
      status: PaiementStatus.SUCCESS,
      mode: PaiementMode.CASH,
      source: 'cash',
      order_id: COMMANDE,
    });
    prisma.order.findUnique.mockResolvedValue({ id: COMMANDE, amount: 10000, paied: true, paiements: [] });
    prisma.paiement.findMany.mockResolvedValue(autres.map((a) => ({ status: PaiementStatus.SUCCESS, amount: a })));
    (prisma.paiement as Record<string, jest.Mock>).update = jest.fn().mockResolvedValue({ id: PAIEMENT });
  }

  it('refuse de relever un paiement au-delà du prix de la commande', async () => {
    const { service, prisma } = monter();
    paiementReussi(prisma, 6000, [4000]);

    await expect(service.update(PAIEMENT, { amount: 9000 })).rejects.toThrow(/^Ce montant dépasserait le prix/);
    expect((prisma.paiement as Record<string, jest.Mock>).update).not.toHaveBeenCalled();
  });

  it('laisse baisser un paiement de trop', async () => {
    const { service, prisma } = monter();
    paiementReussi(prisma, 9000, [4000]);

    await service.update(PAIEMENT, { amount: 6000 });
    expect((prisma.paiement as Record<string, jest.Mock>).update).toHaveBeenCalledTimes(1);
  });
});
