import { DelivererPushService } from './deliverer-push.service';

/**
 * Offre à un livreur sans jeton de notification : rien n'est envoyé. Si son
 * appli n'est pas connectée en temps réel, il ne verra pas l'offre ; la ligne
 * doit donc se lire en production (avertissement), sans noyer le journal.
 */
describe('DelivererPushService : livreur sans jeton de notification', () => {
  function monter() {
    const prisma = { deliverer: { findUnique: jest.fn(async () => ({ expo_push_token: null, first_name: 'Awa' })) } };
    const expoPush = { sendPushNotifications: jest.fn() };
    const service = new DelivererPushService(prisma as never, expoPush as never);
    const logger = (service as unknown as { logger: { warn: () => void; debug: () => void } }).logger;
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const debug = jest.spyOn(logger, 'debug').mockImplementation(() => undefined);
    return { service, expoPush, warn, debug };
  }

  const offre = { delivererId: 'd1234567-aaaa', courseReference: 'CRS-1', restaurantName: 'Zone 4', courseId: 'c1' };

  it('offre : un avertissement par livreur toutes les 10 min, rien d\'envoyé', async () => {
    const t = monter();
    await t.service.notify({ delivererId: offre.delivererId, type: 'new_course_offer', title: 't', body: 'b' });
    await t.service.notify({ delivererId: offre.delivererId, type: 'new_course_offer', title: 't', body: 'b' });

    expect(t.expoPush.sendPushNotifications).not.toHaveBeenCalled();
    expect(t.warn).toHaveBeenCalledTimes(1);
    expect(t.warn).toHaveBeenCalledWith(
      '[Push] new_course_offer → livreur d1234567 sans jeton de notification : rien envoyé',
    );
  });

  it('autres notifications : niveau debug, comme avant', async () => {
    const t = monter();
    await t.service.notify({ delivererId: offre.delivererId, type: 'pause_rappel', title: 't', body: 'b' });
    expect(t.warn).not.toHaveBeenCalled();
    expect(t.debug).toHaveBeenCalledTimes(1);
  });
});
