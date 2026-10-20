import { Logger } from '@nestjs/common';
import { OrderStatus, OrderType, PaymentMethod } from '@prisma/client';
import { NotificationsSenderService } from './notifications-sender.service';

/**
 * Cloche « commande » du personnel : le texte suit le type de la commande.
 * Recette du 20/10 : à la reprise au téléphone d'une commande du site à
 * livrer, la cloche disait « a confirmé sa présence ». Base simulée.
 */

const caissier = {
  id: 'u-caisse',
  fullname: 'Caissier Zone 4',
  email: 'caissier@test.local',
  phone: null,
  type: 'RESTAURANT',
  role: 'CAISSIER',
  restaurant_id: 'r1',
  restaurant: { name: 'Zone 4' },
  email_notifications_enabled: true,
  in_app_notifications_enabled: true,
};

function monter() {
  const destinataires = {
    getAllUsersByRestaurantAndRole: jest.fn(async () => [caissier]),
    getAllUsersByBackofficeAndRole: jest.fn(async () => []),
  };
  const notificationsService = {
    sendNotificationToMultiple: jest.fn(async (_t: any, ctx: any, _type?: any) =>
      ctx.recipients.map((r: any) => ({ id: `n-${r.id}`, user_id: r.id })),
    ),
  };
  const ws = { emitNotification: jest.fn() };
  const service = new NotificationsSenderService(
    destinataires as any,
    notificationsService as any,
    ws as any,
    {} as any,
    {} as any,
  );
  return { service, notificationsService };
}

beforeAll(() => Logger.overrideLogger(false));

describe('NotificationsSenderService.sendOrderBell', () => {
  it('commande du site à livrer, reprise au téléphone : « Commande à livrer … confirmée »', async () => {
    const { service, notificationsService } = monter();
    // Telle que la relit `OrderService` après la reprise : `auto` à false.
    await service.sendOrderBell({
      id: 'o1',
      reference: 'ORD-261020-52033',
      status: OrderStatus.ACCEPTED,
      amount: 10100,
      restaurant_id: 'r1',
      restaurant: { name: 'CHICKEN NATION ZONE 4' },
      fullname: 'Koffi Essai',
      payment_method: PaymentMethod.OFFLINE,
      type: OrderType.DELIVERY,
      auto: false,
    });
    const [gabarit] = notificationsService.sendNotificationToMultiple.mock.calls[0];
    expect(gabarit.message()).toBe('Commande à livrer #ORD-261020-52033 (Koffi Essai) confirmée. Lancez la cuisson !');
  });

  it('commande de l’application à emporter, à payer au restaurant : le client a confirmé sa présence', async () => {
    const { service, notificationsService } = monter();
    await service.sendOrderBell({
      id: 'o2',
      reference: 'ORD-261020-11111',
      status: OrderStatus.ACCEPTED,
      amount: 5000,
      restaurant_id: 'r1',
      restaurant: { name: 'CHICKEN NATION ZONE 4' },
      fullname: 'Awa',
      payment_method: PaymentMethod.OFFLINE,
      type: OrderType.PICKUP,
      auto: true,
    });
    const [gabarit] = notificationsService.sendNotificationToMultiple.mock.calls[0];
    expect(gabarit.message()).toBe('Le client Awa a confirmé sa présence. Lancez la cuisson pour la commande #ORD-261020-11111 !');
  });
});
