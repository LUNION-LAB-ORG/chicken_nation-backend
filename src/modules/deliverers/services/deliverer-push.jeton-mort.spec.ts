import { ExpoPushService } from 'src/expo-push/expo-push.service';

import { aUnJetonDeNotification } from '../helpers/disponibilite.rules';
import { DelivererPushService } from './deliverer-push.service';

/**
 * Jeton qu'Expo déclare inconnu (`DeviceNotRegistered`) : effacé pour un
 * livreur comme pour un client.
 *
 * Seul le réglage du client était révoqué. Le livreur gardait son jeton mort
 * et comptait donc encore comme joignable pour les offres (règle des livreurs
 * joignables) : aucune notification ne pouvait lui arriver.
 */
describe('DelivererPushService : jeton de notification mort', () => {
  const MORT = 'ExponentPushToken[mort-mort-mort]';
  const NEUF = 'ExponentPushToken[neuf-neuf-neuf]';

  type Ligne = Record<string, unknown> & { expo_push_token: string | null };

  /** `updateMany` filtré sur la valeur du jeton, comme Postgres. */
  const table = (lignes: Ligne[]) => ({
    updateMany: jest.fn(async ({ where, data }: { where: { expo_push_token: string }; data: Record<string, unknown> }) => {
      let count = 0;
      for (const l of lignes) {
        if (l.expo_push_token === where.expo_push_token) {
          Object.assign(l, data);
          count++;
        }
      }
      return { count };
    }),
  });

  function monter(reponseExpo: (jeton: string) => Record<string, unknown>, pendantEnvoi?: () => void) {
    const livreur: Ligne = { id: 'liv-1', first_name: 'Awa', protocole_appli: 3, expo_push_token: MORT };
    const reglage: Ligne = { customer_id: 'cli-1', expo_push_token: 'ExponentPushToken[client]' };

    const prisma = {
      deliverer: {
        ...table([livreur]),
        findUnique: jest.fn(async () => ({ ...livreur })),
      },
      notificationSetting: table([reglage]),
    };

    const expoPush = new ExpoPushService(prisma as never);
    const journal = (expoPush as unknown as { logger: { log: () => void; warn: () => void; error: () => void } }).logger;
    for (const niveau of ['log', 'warn', 'error'] as const) jest.spyOn(journal, niveau).mockImplementation(() => undefined);
    (expoPush as unknown as { expo: unknown }).expo = {
      chunkPushNotifications: (messages: unknown[]) => [messages],
      sendPushNotificationsAsync: jest.fn(async (lot: { to: string }[]) => {
        pendantEnvoi?.();
        return lot.map((m) => reponseExpo(m.to));
      }),
      chunkPushNotificationReceiptIds: (ids: string[]) => [ids],
      getPushNotificationReceiptsAsync: jest.fn(async () => ({
        'recu-1': { status: 'error', message: 'inconnu', details: { error: 'DeviceNotRegistered' } },
      })),
    };

    const service = new DelivererPushService(prisma as never, expoPush);
    jest.spyOn((service as unknown as { logger: { log: () => void } }).logger, 'log').mockImplementation(() => undefined);
    return { service, expoPush, prisma, livreur, reglage };
  }

  const appareilInconnu = (jeton: string) => ({
    status: 'error',
    message: `"${jeton}" is not a registered push notification recipient`,
    details: { error: 'DeviceNotRegistered', expoPushToken: jeton },
  });

  /** La révocation part sans être attendue par l'envoi : on laisse la file se vider. */
  const vider = () => new Promise((r) => setImmediate(r));

  const offre = { delivererId: 'liv-1', type: 'new_course_offer' as const, title: 'Nouvelle course !', body: 'b' };

  it("appareil inconnu à l'envoi : le jeton du livreur est effacé, il n'est plus joignable par notification", async () => {
    const t = monter(appareilInconnu);

    await t.service.notify(offre);
    await vider();

    expect(t.livreur.expo_push_token).toBeNull();
    expect(aUnJetonDeNotification(t.livreur.expo_push_token)).toBe(false);
    expect(t.prisma.deliverer.updateMany).toHaveBeenCalledWith({
      where: { expo_push_token: MORT },
      data: { expo_push_token: null },
    });
  });

  it('jeton plus récent enregistré entre-temps : gardé', async () => {
    const t = monter(appareilInconnu, () => {
      // L'appli rouverte envoie son nouveau jeton pendant que l'ancien échoue.
      t.livreur.expo_push_token = NEUF;
    });

    await t.service.notify(offre);
    await vider();

    expect(t.livreur.expo_push_token).toBe(NEUF);
  });

  it('autre échec (quota, panne) : rien effacé', async () => {
    const t = monter(() => ({ status: 'error', message: 'trop', details: { error: 'MessageRateExceeded' } }));

    await t.service.notify(offre);
    await vider();

    expect(t.livreur.expo_push_token).toBe(MORT);
    expect(t.prisma.deliverer.updateMany).not.toHaveBeenCalled();
  });

  it('appareil inconnu au reçu (phase 2) : effacé aussi', async () => {
    const t = monter(() => ({ status: 'ok', id: 'recu-1' }));

    await t.expoPush.verifierRecus([{ id: 'recu-1', token: MORT }]);

    expect(t.livreur.expo_push_token).toBeNull();
  });

  it('le jeton du client reste révoqué comme avant, sans toucher au livreur', async () => {
    const t = monter(appareilInconnu);

    await t.expoPush.sendPushNotifications({ tokens: ['ExponentPushToken[client]'], title: 't', body: 'b' });
    await vider();

    expect(t.reglage.expo_push_token).toBeNull();
    expect(t.reglage.expo_push_token_revoked).toBe('ExponentPushToken[client]');
    expect(t.livreur.expo_push_token).toBe(MORT);
  });
});
