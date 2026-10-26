/**
 * GET /orders/:id/livraison (section « Livraison » du tiroir de détail) :
 * mêmes gardes et même cloisonnement que le détail d'une commande, et le
 * téléphone du livreur passe par le masquage global des coordonnées. Le code
 * de retrait du client (`code_client`) n'est rendu qu'à l'administrateur et au
 * call center (26/10).
 */

import { CallHandler, ExecutionContext, ForbiddenException, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import { User, UserRole, UserType } from '@prisma/client';
import type { Request } from 'express';
import { lastValueFrom, of } from 'rxjs';
import { MasquerContactsInterceptor } from 'src/common/securite/masquer-contacts.interceptor';
import { REQUIRE_PERMISSION_KEY } from 'src/modules/auth/decorators/user-require-permission';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { resolveStaffType } from 'src/modules/users/helpers/staff-type.helper';
import type { SuiviLivraison } from '../helpers/suivi-livraison.rules';
import { OrderController } from './order.controller';

const RESTAURANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RESTAURANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const SUIVI: SuiviLivraison = {
  service: 'CHICKEN_NATION',
  course: {
    id: 'crs-1',
    reference: 'CRS-261024-00001',
    code_retrait: '614',
    nombre_commandes: 1,
    rang_arret: 1,
    statut: 'ACCEPTED',
    fin_prevue: null,
    en_retard: false,
    retard_min: null,
  },
  livreur: { id: 'liv-koffi', nom: 'Koffi Kouassi', telephone: '+2250701020304', etat: 'vers_restaurant' },
  tournee: [{ reference: 'ORD-261024-00001', rang: 1, etat: 'a_livrer', heure: null, cette_commande: true }],
  echec: null,
  etapes: [{ cle: 'acceptee', heure: '2026-10-24T12:02:00.000Z', prevue: null }],
  durees: { vers_restaurant_s: null, attente_comptoir_s: null, vers_client_s: null, pret_a_livre_s: null },
};

function monter(restaurantDeLaCommande: string | null = RESTAURANT_A) {
  const service = {
    lire: jest.fn().mockResolvedValue({ id: 'o1', restaurant_id: restaurantDeLaCommande }),
    suivi: jest.fn().mockResolvedValue(SUIVI),
    codeClient: jest.fn().mockResolvedValue('4821'),
  };
  const controleur = new OrderController(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    undefined,
    service as never,
  );
  return { controleur, service };
}

const compte = (role: UserRole, type: UserType, restaurant_id: string | null = null) =>
  ({ id: 'u1', role, type, restaurant_id }) as unknown as User;

const requete = (user: User) => ({ user }) as unknown as Request;

describe('GET /orders/:id/livraison : gardes', () => {
  const livraison = OrderController.prototype.suiviDeLivraison;
  const detail = OrderController.prototype.findOne;

  it('mêmes gardes et même permission que le détail de la commande', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, livraison)).toEqual(Reflect.getMetadata(GUARDS_METADATA, detail));
    expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, livraison)).toEqual(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, detail));
  });

  it('chaque rôle reçoit la même réponse de la garde que pour le détail (LIVRAISON_OPS ouvert, MARKETING fermé)', () => {
    const garde = new UserPermissionsGuard(new Reflector());
    const autorise = (role: UserRole, route: object) =>
      garde.canActivate({
        getHandler: () => route,
        switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
      } as unknown as ExecutionContext);
    for (const role of Object.values(UserRole)) {
      expect([role, autorise(role, livraison)]).toEqual([role, autorise(role, detail)]);
    }
    expect(autorise(UserRole.LIVRAISON_OPS, livraison)).toBe(true);
    expect(autorise(UserRole.MARKETING, livraison)).toBe(false);
  });
});

describe('GET /orders/:id/livraison : cloisonnement', () => {
  it("refuse à un compte de restaurant la commande d'un autre restaurant, sans rien calculer", async () => {
    const { controleur, service } = monter(RESTAURANT_B);
    await expect(
      controleur.suiviDeLivraison(requete(compte(UserRole.CAISSIER, UserType.RESTAURANT, RESTAURANT_A)), 'o1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.suivi).not.toHaveBeenCalled();
  });

  it('rend le suivi à un compte du restaurant de la commande', async () => {
    const { controleur, service } = monter(RESTAURANT_A);
    const r = await controleur.suiviDeLivraison(requete(compte(UserRole.MANAGER, UserType.RESTAURANT, RESTAURANT_A)), 'o1');
    expect(r).toBe(SUIVI);
    expect(service.suivi).toHaveBeenCalledWith({ id: 'o1', restaurant_id: RESTAURANT_A });
  });

  it("un compte de siège lit toutes les commandes ; seuls l'administrateur et le centre d'appels ouvrent un panier annulé par le client", async () => {
    for (const [role, paniers] of [
      [UserRole.LIVRAISON_OPS, false],
      [UserRole.CALL_CENTER, true],
      [UserRole.ADMIN, true],
    ] as const) {
      const { controleur, service } = monter(RESTAURANT_B);
      // Le suivi, plus `code_client` pour l'administrateur et le centre d'appels (26/10).
      await expect(controleur.suiviDeLivraison(requete(compte(role, UserType.BACKOFFICE)), 'ORD-261024-34769')).resolves.toMatchObject(SUIVI);
      expect(service.lire).toHaveBeenCalledWith('ORD-261024-34769', { inclurePanierAnnuleParClient: paniers });
    }
  });

  it('commande introuvable : 404 du service, rendu tel quel', async () => {
    const { controleur, service } = monter();
    service.lire.mockRejectedValueOnce(new NotFoundException('Commande introuvable'));
    await expect(
      controleur.suiviDeLivraison(requete(compte(UserRole.ADMIN, UserType.BACKOFFICE)), 'inconnue'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('GET /orders/:id/livraison : code de retrait du client (26/10)', () => {
  /** Compte du rôle, du type que lui donne le serveur, rattaché au restaurant de la commande s'il en a un. */
  const lire = async (role: UserRole) => {
    const { controleur, service } = monter(RESTAURANT_A);
    const type = resolveStaffType(role);
    const user = compte(role, type, type === UserType.RESTAURANT ? RESTAURANT_A : null);
    const reponse = (await controleur.suiviDeLivraison(requete(user), 'o1')) as unknown as Record<string, unknown>;
    return { reponse, service, user };
  };

  it.each([UserRole.ADMIN, UserRole.CALL_CENTER])('%s : `code_client` présent, à côté du suivi inchangé', async (role) => {
    const { reponse, service, user } = await lire(role);
    expect(reponse).toEqual({ ...SUIVI, code_client: '4821' });
    expect(service.codeClient).toHaveBeenCalledTimes(1);
    expect(service.codeClient).toHaveBeenCalledWith({ id: 'o1', restaurant_id: RESTAURANT_A }, user);
    // Le « Code retrait » de la course (donné à la caisse) ne bouge pas.
    expect((reponse.course as { code_retrait: string }).code_retrait).toBe('614');
  });

  it('commande sans code : `code_client` présent à null pour ces deux rôles', async () => {
    for (const role of [UserRole.ADMIN, UserRole.CALL_CENTER]) {
      const { controleur, service } = monter(RESTAURANT_A);
      service.codeClient.mockResolvedValueOnce(null);
      const reponse = (await controleur.suiviDeLivraison(
        requete(compte(role, UserType.BACKOFFICE)),
        'o1',
      )) as unknown as Record<string, unknown>;
      expect([role, 'code_client' in reponse, reponse.code_client]).toEqual([role, true, null]);
    }
  });

  it.each([
    UserRole.CAISSIER,
    UserRole.MANAGER,
    UserRole.ASSISTANT_MANAGER,
    UserRole.LIVRAISON_OPS,
    UserRole.MARKETING,
    UserRole.CUISINE,
    UserRole.COMPTABLE,
  ])('%s : `code_client` ABSENT (pas null), et le code n’est même pas lu', async (role) => {
    const { reponse, service } = await lire(role);
    expect('code_client' in reponse).toBe(false);
    expect(Object.keys(JSON.parse(JSON.stringify(reponse)))).not.toContain('code_client');
    expect(reponse).toBe(SUIVI);
    expect(service.codeClient).not.toHaveBeenCalled();
  });

  it('chaque rôle est couvert : présent pour ADMIN et CALL_CENTER, absent pour tous les autres', async () => {
    for (const role of Object.values(UserRole)) {
      const { reponse } = await lire(role);
      expect([role, 'code_client' in reponse]).toEqual([role, role === UserRole.ADMIN || role === UserRole.CALL_CENTER]);
    }
  });

  it("commande d'un autre restaurant : refusée avant toute lecture du code", async () => {
    const { controleur, service } = monter(RESTAURANT_B);
    await expect(
      controleur.suiviDeLivraison(requete(compte(UserRole.MANAGER, UserType.RESTAURANT, RESTAURANT_A)), 'o1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.codeClient).not.toHaveBeenCalled();
  });
});

describe('GET /orders/:id/livraison : masquage des coordonnées', () => {
  function intercepter(role: UserRole) {
    const contexte = {
      getType: () => 'http',
      getHandler: () => OrderController.prototype.suiviDeLivraison,
      getClass: () => OrderController,
      switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
    } as unknown as ExecutionContext;
    const suite: CallHandler = { handle: () => of(SUIVI) };
    // Vrai Reflector : la route ne doit porter aucune dispense (@SansMasquage).
    return lastValueFrom(new MasquerContactsInterceptor(new Reflector()).intercept(contexte, suite)) as Promise<SuiviLivraison>;
  }

  it('masque le téléphone du livreur pour le marketing', async () => {
    const r = await intercepter(UserRole.MARKETING);
    expect(r.livreur?.telephone).toBe('+225••••••••04');
    expect(r.livreur?.nom).toBe('Koffi Kouassi');
    expect(r.course).toEqual(SUIVI.course);
  });

  it('le laisse lisible pour les rôles qui appellent le livreur', async () => {
    for (const role of [UserRole.CALL_CENTER, UserRole.LIVRAISON_OPS, UserRole.CAISSIER, UserRole.ADMIN]) {
      expect((await intercepter(role)).livreur?.telephone).toBe('+2250701020304');
    }
  });
});
