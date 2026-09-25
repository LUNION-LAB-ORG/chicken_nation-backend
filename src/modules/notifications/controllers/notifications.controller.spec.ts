import { ForbiddenException, RequestMethod } from '@nestjs/common';
import { INTERCEPTORS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { NotificationTarget, UserRole } from '@prisma/client';
import type { Request } from 'express';
import { NotificationsService } from '../services/notifications.service';
import { NotificationsController } from './notifications.controller';

const MEMBRE_ID = '11111111-1111-4111-8111-111111111111';
const CLIENT_ID = '22222222-2222-4222-8222-222222222222';
const NOTIF_ID = '33333333-3333-4333-8333-333333333333';

const membre = { id: MEMBRE_ID, role: UserRole.CAISSIER };
const client = { id: CLIENT_ID, phone: '+2250700000000' };
const requete = (user: unknown) => ({ user }) as unknown as Request;

function monter() {
  const service = {
    findByUser: jest.fn().mockResolvedValue({ data: [], meta: {} }),
    getStatsByUser: jest.fn().mockResolvedValue({}),
    findOne: jest.fn().mockResolvedValue({}),
    markAsRead: jest.fn().mockResolvedValue({}),
    markAsUnread: jest.fn().mockResolvedValue({}),
    markAllAsReadByUser: jest.fn().mockResolvedValue({}),
    remove: jest.fn().mockResolvedValue({}),
    removeAllByUser: jest.fn().mockResolvedValue({}),
  };
  return { service, controller: new NotificationsController(service as unknown as NotificationsService) };
}

/** Routes déclarées par le contrôleur, sous la forme « VERBE chemin ». */
function routes(): string[] {
  const proto = NotificationsController.prototype;
  return Object.getOwnPropertyNames(proto)
    .filter((nom) => nom !== 'constructor')
    .map((nom) => proto[nom as keyof typeof proto])
    .filter((fn) => typeof fn === 'function' && Reflect.hasMetadata(PATH_METADATA, fn))
    .map((fn) => `${RequestMethod[Reflect.getMetadata(METHOD_METADATA, fn)]} ${Reflect.getMetadata(PATH_METADATA, fn)}`)
    .sort();
}

describe('NotificationsController, surface exposée', () => {
  it('ne garde que les routes de la cloche : plus de création, de liste globale ni de réécriture libre', () => {
    expect(routes()).toEqual(
      [
        'DELETE :id',
        'DELETE user/:userId/:target',
        'GET :id',
        'GET stats/:userId/:target',
        'GET user/:userId/:target',
        'PATCH :id/read',
        'PATCH :id/unread',
        'PATCH user/:userId/:target/read-all',
      ].sort(),
    );
  });

  it("n'a plus de cache par URL, partagé entre tous les jetons, ni sur le contrôleur ni sur une route", () => {
    expect(Reflect.getMetadata(INTERCEPTORS_METADATA, NotificationsController)).toBeUndefined();

    const proto = NotificationsController.prototype;
    for (const nom of Object.getOwnPropertyNames(proto)) {
      const fn = proto[nom as keyof typeof proto];
      if (typeof fn === 'function') {
        expect(Reflect.getMetadata(INTERCEPTORS_METADATA, fn)).toBeUndefined();
      }
    }
  });
});

describe('NotificationsController, propriétaire imposé', () => {
  it('le personnel lit sa propre cloche USER', async () => {
    const { service, controller } = monter();

    await controller.findByUser(requete(membre), MEMBRE_ID, NotificationTarget.USER, 2, 1000);

    expect(service.findByUser).toHaveBeenCalledWith(
      { user_id: MEMBRE_ID, target: NotificationTarget.USER },
      { page: 2, limit: 1000, type: undefined, isRead: undefined },
    );
  });

  it('le client lit sa propre cloche CUSTOMER et ses statistiques', async () => {
    const { service, controller } = monter();

    await controller.findByUser(requete(client), CLIENT_ID, NotificationTarget.CUSTOMER);
    await controller.getStats(requete(client), CLIENT_ID, NotificationTarget.CUSTOMER);

    const proprietaire = { user_id: CLIENT_ID, target: NotificationTarget.CUSTOMER };
    expect(service.findByUser.mock.calls[0][0]).toEqual(proprietaire);
    expect(service.getStatsByUser).toHaveBeenCalledWith(proprietaire);
  });

  it("refuse la cloche d'un autre (403), même avec la bonne cible", async () => {
    const { service, controller } = monter();

    await expect(controller.findByUser(requete(membre), CLIENT_ID, NotificationTarget.USER)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.getStats(requete(client), MEMBRE_ID, NotificationTarget.CUSTOMER)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.markAllAsRead(requete(membre), CLIENT_ID, NotificationTarget.USER)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.removeAllByUser(requete(client), MEMBRE_ID, NotificationTarget.CUSTOMER)).rejects.toBeInstanceOf(ForbiddenException);

    expect(service.findByUser).not.toHaveBeenCalled();
    expect(service.getStatsByUser).not.toHaveBeenCalled();
    expect(service.markAllAsReadByUser).not.toHaveBeenCalled();
    expect(service.removeAllByUser).not.toHaveBeenCalled();
  });

  it("refuse son propre identifiant avec la cible de l'autre population (403)", async () => {
    const { service, controller } = monter();

    await expect(controller.findByUser(requete(client), CLIENT_ID, NotificationTarget.USER)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(controller.markAllAsRead(requete(membre), MEMBRE_ID, NotificationTarget.CUSTOMER)).rejects.toBeInstanceOf(ForbiddenException);

    expect(service.findByUser).not.toHaveBeenCalled();
    expect(service.markAllAsReadByUser).not.toHaveBeenCalled();
  });

  it('les routes par identifiant transmettent toujours le propriétaire du jeton', async () => {
    const { service, controller } = monter();
    const proprietaire = { user_id: MEMBRE_ID, target: NotificationTarget.USER };

    await controller.findOne(requete(membre), NOTIF_ID);
    await controller.markAsRead(requete(membre), NOTIF_ID);
    await controller.markAsUnread(requete(membre), NOTIF_ID);
    await controller.remove(requete(membre), NOTIF_ID);

    for (const methode of [service.findOne, service.markAsRead, service.markAsUnread, service.remove]) {
      expect(methode).toHaveBeenCalledWith(NOTIF_ID, proprietaire);
    }
  });

  it('refuse une requête sans principal', async () => {
    const { service, controller } = monter();

    await expect(controller.findOne(requete(undefined), NOTIF_ID)).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.findOne).not.toHaveBeenCalled();
  });
});
