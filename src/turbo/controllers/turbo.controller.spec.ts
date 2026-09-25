import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  RequestMethod,
} from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { UserType } from '@prisma/client';
import { REQUIRE_PERMISSION_KEY } from 'src/modules/auth/decorators/user-require-permission';
import { Action } from 'src/modules/auth/enums/action.enum';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { TurboController } from './turbo.controller';

function routesExposees(): { methode: string; chemin: string; nom: string }[] {
  const prototype = TurboController.prototype as unknown as Record<string, object>;
  return Object.getOwnPropertyNames(prototype)
    .filter((nom) => nom !== 'constructor')
    .map((nom) => ({ nom, gestionnaire: prototype[nom] }))
    .filter(({ gestionnaire }) => typeof gestionnaire === 'function' && Reflect.hasMetadata(PATH_METADATA, gestionnaire))
    .map(({ nom, gestionnaire }) => ({
      nom,
      methode: RequestMethod[Reflect.getMetadata(METHOD_METADATA, gestionnaire) as number],
      chemin: Reflect.getMetadata(PATH_METADATA, gestionnaire) as string,
    }));
}

describe('TurboController', () => {
  it('n\'expose plus les relais de frais de livraison', () => {
    const chemins = routesExposees().map((r) => `${r.methode} ${r.chemin}`);
    expect(chemins.sort()).toEqual(['POST creer-course', 'POST livraison/valider-code', 'POST webhook']);
    expect(chemins.join(' ')).not.toContain('obtenir-frais-livraison');
  });

  it('creer-course reste réservée au personnel', () => {
    const gardes = Reflect.getMetadata(GUARDS_METADATA, TurboController.prototype.creerCourse) as unknown[];
    expect(gardes).toEqual([JwtAuthGuard, UserPermissionsGuard]);
    expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, TurboController.prototype.creerCourse)).toEqual({
      module: Modules.COMMANDES,
      action: Action.CREATE,
    });
  });

  describe('creer-course', () => {
    const COMMANDE = '5b1d3c1e-8f2a-4c6b-9d0e-1a2b3c4d5e6f';
    const caissierR1 = { id: 'u1', type: UserType.RESTAURANT, restaurant_id: 'r1' };
    const caissierR2 = { id: 'u2', type: UserType.RESTAURANT, restaurant_id: 'r2' };
    const backoffice = { id: 'u9', type: UserType.BACKOFFICE, restaurant_id: null };

    function creer(commande: unknown = { restaurant_id: 'r1', restaurant: { apikey: 'cle-du-restaurant' } }) {
      const turbo = { creerCourse: jest.fn().mockResolvedValue({ ok: true }) };
      const prisma = { order: { findUnique: jest.fn().mockResolvedValue(commande) } };
      const controleur = new TurboController(turbo as never, {} as never, prisma as never);
      return { controleur, turbo, prisma };
    }

    const requete = (user: unknown) => ({ user }) as never;

    it('transmet à Turbo la clé du restaurant lue en base, jamais celle du corps', async () => {
      const { controleur, turbo, prisma } = creer();
      await expect(
        controleur.creerCourse(requete(caissierR1), { order_id: COMMANDE, apikey: 'cle-choisie' } as never),
      ).resolves.toEqual({ ok: true });
      expect(prisma.order.findUnique).toHaveBeenCalledWith({
        where: { id: COMMANDE },
        select: { restaurant_id: true, restaurant: { select: { apikey: true } } },
      });
      expect(turbo.creerCourse).toHaveBeenCalledWith(COMMANDE, 'cle-du-restaurant');
    });

    it('refuse la commande d\'un autre restaurant', async () => {
      const { controleur, turbo } = creer();
      await expect(
        controleur.creerCourse(requete(caissierR2), { order_id: COMMANDE }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(turbo.creerCourse).not.toHaveBeenCalled();
    });

    it('le backoffice agit sur tous les restaurants', async () => {
      const { controleur, turbo } = creer();
      await controleur.creerCourse(requete(backoffice), { order_id: COMMANDE });
      expect(turbo.creerCourse).toHaveBeenCalledWith(COMMANDE, 'cle-du-restaurant');
    });

    it.each([undefined, '', 'pas-un-uuid', 42, { id: COMMANDE }])(
      'identifiant de commande %p : refusé sans lire la base',
      async (orderId) => {
        const { controleur, turbo, prisma } = creer();
        await expect(
          controleur.creerCourse(requete(backoffice), { order_id: orderId }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(prisma.order.findUnique).not.toHaveBeenCalled();
        expect(turbo.creerCourse).not.toHaveBeenCalled();
      },
    );

    it('corps absent : refusé', async () => {
      const { controleur } = creer();
      await expect(
        controleur.creerCourse(requete(backoffice), undefined as never),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('commande introuvable : 404', async () => {
      const { controleur, turbo } = creer(null);
      await expect(
        controleur.creerCourse(requete(backoffice), { order_id: COMMANDE }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(turbo.creerCourse).not.toHaveBeenCalled();
    });

    it('restaurant sans clé Turbo : refusé, rien n\'est envoyé', async () => {
      const { controleur, turbo } = creer({ restaurant_id: 'r1', restaurant: { apikey: null } });
      await expect(
        controleur.creerCourse(requete(caissierR1), { order_id: COMMANDE }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(turbo.creerCourse).not.toHaveBeenCalled();
    });
  });

  describe('webhook', () => {
    function creer(reject = false) {
      const webhook = { verifierCleApi: jest.fn().mockResolvedValue({ reject }) };
      const controleur = new TurboController({} as never, webhook as never, {} as never);
      return { controleur, webhook };
    }

    it('événement inconnu : accusé de réception sans traitement, plus d\'erreur 500', async () => {
      const { controleur } = creer();
      const avertissement = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      await expect(
        controleur.handleEvent({ alias: 'delivery.inconnu', data: {} } as never, 'cle'),
      ).resolves.toEqual({ event: 'delivery.inconnu', received: true, process: false });
      avertissement.mockRestore();
    });

    it('clé refusée : rien n\'est traité', async () => {
      const { controleur, webhook } = creer(true);
      await expect(
        controleur.handleEvent({ alias: 'delivery.created', data: {} } as never, 'mauvaise-cle'),
      ).resolves.toEqual({ event: 'unauthorized', received: true, process: false });
      expect(webhook.verifierCleApi).toHaveBeenCalledWith('mauvaise-cle');
    });
  });
});
