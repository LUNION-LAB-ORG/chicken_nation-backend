/**
 * Notifications du livreur : textes courts, sans tiret cadratin ni
 * anglicisme ; les événements de la course sonnent sur le canal des offres
 * (demande du 23/10, livreurs qui lisent peu).
 */
import { DelivererPushService, heureCourteAbidjan } from './deliverer-push.service';

function monter() {
  const envois: any[] = [];
  // Nouvelle appli (protocole 3) : les événements de course sur le canal des offres.
  const prisma = {
    deliverer: { findUnique: jest.fn(async () => ({ expo_push_token: 'ExponentPushToken[x]', first_name: 'Koffi', protocole_appli: 3 })) },
  };
  const expo = { sendPushNotifications: jest.fn(async (m: unknown) => void envois.push(m)) };
  const service = new DelivererPushService(prisma as never, expo as never);
  const attendre = () => new Promise((r) => setImmediate(r));
  return { service, envois, attendre };
}

describe('notifications du livreur', () => {
  it('chaque texte : court, sans tiret cadratin ni anglicisme', async () => {
    const { service, envois, attendre } = monter();
    const d = 'livreur-1';
    service.notifyPickupValidated({ delivererId: d, courseReference: 'CRS-1', courseId: 'k1' });
    service.notifyCourseCancelled({ delivererId: d, courseReference: 'CRS-1', cancelledBy: 'admin', courseId: 'k1' });
    service.notifyAutoPaused({
      delivererId: d,
      refusalCount: 3,
      windowMinutes: 15,
      durationMinutes: 30,
      jusqua: new Date('2026-10-23T14:32:00.000Z'),
    });
    service.notifyCourseCompleted({ delivererId: d, courseReference: 'CRS-1', courseId: 'k1' });
    service.notifyCourseOfferReminder({ delivererId: d, courseReference: 'CRS-1', restaurantName: 'Zone 4', courseId: 'k1', secondsLeft: 30 });
    service.notifyPresenceCheck({ delivererId: d });
    await attendre();

    const parType = Object.fromEntries(envois.map((e) => [e.data.type === 'new_course_offer' ? 'relance' : e.data.type, e]));
    expect(parType.course_pickup_validated).toMatchObject({ title: 'Sacs remis', body: 'Tu peux partir', channelId: 'offres_v1', sound: 'offre_course.wav' });
    expect(parType.course_cancelled).toMatchObject({ title: 'Course annulée', body: 'CRS-1', channelId: 'offres_v1', sound: 'offre_course.wav' });
    expect(parType.auto_paused).toMatchObject({ title: 'Pause automatique', body: "Jusqu'à 14 h 32", channelId: 'offres_v1' });
    expect(parType.course_completed).toMatchObject({ title: 'Course finie' });
    expect(parType.relance).toMatchObject({ title: 'Offre : 30 s', body: 'Réponds vite' });
    expect(parType.presence_check).toMatchObject({ title: 'Présence', body: "Tu travailles aujourd'hui ?" });

    for (const e of envois) {
      expect(`${e.title} ${e.body}`).not.toMatch(/—|Auto-pause|Check-in/);
      expect(e.title.split(/\s+/).length).toBeLessThanOrEqual(4);
    }
  });

  it('« Sac rendu » (28/10) : la caisse a reçu le sac ; non critique, son du système sur le canal par défaut, jamais la sonnerie des offres', async () => {
    const { service, envois, attendre } = monter();
    service.notifySacRendu({ delivererId: 'livreur-1', orderId: 'o1', reference: 'ORD-123' });
    await attendre();
    expect(envois).toEqual([
      expect.objectContaining({
        title: 'Sac rendu',
        body: 'ORD-123 · merci',
        priority: 'normal',
        channelId: 'default',
        sound: 'default',
        data: { type: 'sac_rendu', orderId: 'o1', reference: 'ORD-123' },
      }),
    ]);
    expect(`${envois[0].title} ${envois[0].body}`).not.toMatch(/—/);
  });

  it('heure courte : « 9 h 05 »', () => {
    expect(heureCourteAbidjan(new Date('2026-10-23T09:05:00.000Z'))).toBe('9 h 05');
  });
});
