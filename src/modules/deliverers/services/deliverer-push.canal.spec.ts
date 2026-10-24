import { canalPourAppli, DelivererPushService } from './deliverer-push.service';

/**
 * Canal et son des notifications selon l'appli du livreur (seconde relecture
 * du 23/10). L'ancienne appli (protocole 2 ou moins) joue le son de toute
 * notification reçue appli ouverte : sur le canal des offres, la validation
 * du retrait, une annulation, une pause automatique ou un changement de
 * course sonnaient comme une nouvelle course sans qu'aucune offre ne
 * s'affiche. Pour elle, seule l'offre garde la sonnerie des offres.
 */
describe('DelivererPushService : canal selon l’appli du livreur', () => {
  function monter(protocole: number | null) {
    const prisma = {
      deliverer: { findUnique: jest.fn(async () => ({ expo_push_token: 'ExponentPushToken[x]', first_name: 'Awa', protocole_appli: protocole })) },
    };
    const expoPush = { sendPushNotifications: jest.fn(async () => undefined) };
    const service = new DelivererPushService(prisma as never, expoPush as never);
    jest.spyOn((service as unknown as { logger: { log: () => void } }).logger, 'log').mockImplementation(() => undefined);
    const envoye = () => (expoPush.sendPushNotifications.mock.calls[0] as unknown as [{ channelId: string; sound: string }])[0];
    return { service, envoye };
  }

  const retrait = { delivererId: 'd1', type: 'course_pickup_validated' as const, title: 'Sacs remis', body: 'Tu peux partir', channelId: 'offres_v1', sound: 'offre_course.wav' };

  it('ancienne appli : validation du retrait sur le son du système, comme avant', async () => {
    const t = monter(2);
    await t.service.notify(retrait);
    expect(t.envoye()).toMatchObject({ channelId: 'default', sound: 'default' });
  });

  it('nouvelle appli (protocole 3) : canal des offres, elle rend la notification muette appli ouverte et vibre elle-même', async () => {
    const t = monter(3);
    await t.service.notify(retrait);
    expect(t.envoye()).toMatchObject({ channelId: 'offres_v1', sound: 'offre_course.wav' });
  });

  it('« Sac oublié » : canal des offres pour la nouvelle appli, type `sac_oublie`, références et nombre de sacs', async () => {
    const t = monter(3);
    t.service.notifySacOublie({ delivererId: 'd1', courseId: 'k1', titre: 'Sac oublié', corps: '1 sac au restaurant', commandes: ['CMD-B'] });
    await new Promise((r) => setImmediate(r));
    expect(t.envoye()).toMatchObject({
      channelId: 'offres_v1',
      sound: 'offre_course.wav',
      title: 'Sac oublié',
      body: '1 sac au restaurant',
      data: expect.objectContaining({ type: 'sac_oublie', courseId: 'k1', commandes: ['CMD-B'], sacs: 1 }),
    });
  });

  it('l’offre garde la sonnerie des offres pour toutes les applis', () => {
    const offre = { type: 'new_course_offer' as const, channelId: 'offres_v1', sound: 'offre_course.wav' };
    expect(canalPourAppli(offre, null)).toEqual({ channelId: 'offres_v1', sound: 'offre_course.wav' });
    expect(canalPourAppli(offre, 1)).toEqual({ channelId: 'offres_v1', sound: 'offre_course.wav' });
    for (const type of ['course_cancelled', 'auto_paused', 'commande_ajoutee', 'course_attente'] as const) {
      expect(canalPourAppli({ type, channelId: 'offres_v1', sound: 'offre_course.wav' }, null)).toEqual({ channelId: 'default', sound: 'default' });
    }
    expect(canalPourAppli({ type: 'plan_sent' }, 3)).toEqual({ channelId: 'default', sound: 'default' });
  });
});
