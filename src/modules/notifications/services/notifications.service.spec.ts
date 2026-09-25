import { NotFoundException } from '@nestjs/common';
import { NotificationTarget, NotificationType } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { NotificationsService } from './notifications.service';
import { NotificationOwner } from './notification-owner.util';

const NOTIF_ID = '33333333-3333-4333-8333-333333333333';
const moi: NotificationOwner = {
  user_id: '11111111-1111-4111-8111-111111111111',
  target: NotificationTarget.USER,
};

/** Prisma factice : seules les méthodes de la table notification servent ici. */
function fauxPrisma() {
  const notification = {
    findMany: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
    findFirst: jest.fn(),
    updateMany: jest.fn(),
    deleteMany: jest.fn(),
    groupBy: jest.fn().mockResolvedValue([]),
  };
  return { notification, service: new NotificationsService({ notification } as unknown as PrismaService) };
}

describe('NotificationsService, cloisonnement par propriétaire', () => {
  it('liste uniquement la cloche du propriétaire, page plafonnée à 100', async () => {
    const { notification, service } = fauxPrisma();
    notification.count.mockResolvedValue(250);

    const res = await service.findByUser(moi, { page: 1, limit: 1000 });

    const appel = notification.findMany.mock.calls[0][0];
    expect(appel.where).toEqual({ user_id: moi.user_id, target: moi.target });
    expect(appel.take).toBe(100);
    expect(appel.skip).toBe(0);
    expect(res.meta).toEqual({ total: 250, page: 1, limit: 100, totalPages: 3 });
  });

  it('applique les filtres type et isRead sans lâcher le propriétaire', async () => {
    const { notification, service } = fauxPrisma();

    await service.findByUser(moi, { type: NotificationType.ORDER, isRead: false });

    expect(notification.findMany.mock.calls[0][0].where).toEqual({
      user_id: moi.user_id,
      target: moi.target,
      type: NotificationType.ORDER,
      is_read: false,
    });
    expect(notification.count.mock.calls[0][0].where).toEqual(notification.findMany.mock.calls[0][0].where);
  });

  it("findOne cherche par id ET propriétaire, 404 pour la notification d'un autre", async () => {
    const { notification, service } = fauxPrisma();
    notification.findFirst.mockResolvedValue(null);

    await expect(service.findOne(NOTIF_ID, moi)).rejects.toBeInstanceOf(NotFoundException);
    expect(notification.findFirst).toHaveBeenCalledWith({
      where: { id: NOTIF_ID, user_id: moi.user_id, target: moi.target },
    });
  });

  it('markAsRead ne change que is_read, filtré sur le propriétaire, et renvoie la ligne relue', async () => {
    const { notification, service } = fauxPrisma();
    const ligne = { id: NOTIF_ID, ...moi, is_read: true };
    notification.updateMany.mockResolvedValue({ count: 1 });
    notification.findFirst.mockResolvedValue(ligne);

    await expect(service.markAsRead(NOTIF_ID, moi)).resolves.toBe(ligne);

    const appel = notification.updateMany.mock.calls[0][0];
    expect(appel.where).toEqual({ id: NOTIF_ID, user_id: moi.user_id, target: moi.target });
    expect(Object.keys(appel.data).sort()).toEqual(['is_read', 'updated_at']);
    expect(appel.data.is_read).toBe(true);
  });

  it("markAsUnread répond 404 sans rien relire quand la notification n'est pas au propriétaire", async () => {
    const { notification, service } = fauxPrisma();
    notification.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.markAsUnread(NOTIF_ID, moi)).rejects.toBeInstanceOf(NotFoundException);
    expect(notification.updateMany.mock.calls[0][0].data.is_read).toBe(false);
    expect(notification.findFirst).not.toHaveBeenCalled();
  });

  it("remove supprime par id ET propriétaire, 404 pour la notification d'un autre", async () => {
    const { notification, service } = fauxPrisma();
    notification.deleteMany.mockResolvedValue({ count: 0 });

    await expect(service.remove(NOTIF_ID, moi)).rejects.toBeInstanceOf(NotFoundException);
    expect(notification.deleteMany).toHaveBeenCalledWith({
      where: { id: NOTIF_ID, user_id: moi.user_id, target: moi.target },
    });

    notification.deleteMany.mockResolvedValue({ count: 1 });
    await expect(service.remove(NOTIF_ID, moi)).resolves.toEqual({ message: 'Notification supprimée avec succès' });
  });

  it('les opérations groupées restent sur le couple du propriétaire', async () => {
    const { notification, service } = fauxPrisma();
    notification.updateMany.mockResolvedValue({ count: 2 });
    notification.deleteMany.mockResolvedValue({ count: 3 });

    await service.markAllAsReadByUser(moi);
    await service.removeAllByUser(moi);
    await service.getStatsByUser(moi);

    expect(notification.updateMany.mock.calls[0][0].where).toEqual({ user_id: moi.user_id, target: moi.target, is_read: false });
    expect(notification.deleteMany.mock.calls[0][0].where).toEqual({ user_id: moi.user_id, target: moi.target });
    expect(notification.groupBy.mock.calls[0][0].where).toEqual({ user_id: moi.user_id, target: moi.target });
    for (const [arg] of notification.count.mock.calls) {
      expect(arg.where).toMatchObject({ user_id: moi.user_id, target: moi.target });
    }
  });
});
