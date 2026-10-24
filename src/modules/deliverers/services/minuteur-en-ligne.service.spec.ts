/**
 * Minuteur « en ligne » tenu par le serveur (demande du 24/10) : signes de
 * vie, pauses, 05 h, deux serveurs, Redis muet, et exposition dans
 * `GET /deliverers/me/scoring-info`.
 */
import { DelivererStatus, EntityStatus } from '@prisma/client';

import { RedisMinuteurSimule } from '../helpers/minuteur-en-ligne.redis-simule-spec';
import { MinuteurEnLigneListener } from '../listeners/minuteur-en-ligne.listener';
import { DelivererInfoService } from './deliverer-info.service';
import { MinuteurEnLigneService } from './minuteur-en-ligne.service';

const T0 = new Date('2026-10-24T10:00:00.000Z').getTime();
const a = (secondes: number) => new Date(T0 + secondes * 1000);
const LOIN = new Date('2099-12-31T23:59:59Z');

interface Livreur {
  pause_until: Date | null;
  auto_pause_until: Date | null;
  last_available_at: Date | null;
}

function monter(reglages: { appliFermeeApresS?: number } = {}) {
  const redis = new RedisMinuteurSimule();
  const livreur: Livreur = { pause_until: null, auto_pause_until: null, last_available_at: a(-3600) };
  const etat = { enCourse: false };
  const prisma = {
    deliverer: { findUnique: jest.fn(async () => ({ ...livreur })) },
    course: { findFirst: jest.fn(async () => (etat.enCourse ? { id: 'course-1' } : null)) },
  };
  const appliFermeeApresS = reglages.appliFermeeApresS ?? 180;
  const settings = { load: jest.fn(async () => ({ appliFermeeApresS })) };
  /** Un serveur de plus, sur le même Redis et la même base. */
  const serveur = () => new MinuteurEnLigneService(redis as never, prisma as never, settings as never);
  const minuteur = serveur();
  const lire = (t: Date, enLigne = true, m = minuteur) => m.lire('l1', enLigne, appliFermeeApresS, t);
  /** Signes de vie de `de` à `a` (inclus), toutes les `pas` secondes. */
  const signaux = async (de: number, jusqua: number, pas = 60, m = minuteur) => {
    for (let t = de; t <= jusqua; t += pas) await m.noterSignal('l1', a(t));
  };
  return { redis, livreur, etat, prisma, settings, serveur, minuteur, lire, signaux };
}

describe('MinuteurEnLigneService', () => {
  it('signes de vie toutes les 60 s pendant 10 min : 600 s', async () => {
    const m = monter();
    await m.signaux(0, 600);
    expect(await m.lire(a(600))).toBe(600);
  });

  it('positions toutes les 5 s en livraison : une avance toutes les 30 s au plus, rien de perdu', async () => {
    const m = monter();
    await m.signaux(0, 600, 5);
    expect(await m.lire(a(600))).toBe(600);
    expect(m.redis.scriptsRecus).toBe(21);
  });

  it('un trou de 10 min (connexion coupée, appli fermée, panne) n’est pas compté', async () => {
    const m = monter();
    await m.signaux(0, 300);
    await m.signaux(900, 1200);
    expect(await m.lire(a(1200))).toBe(300 + 300);
  });

  it('une pause n’est pas comptée, arrêtée et relancée à l’instant exact', async () => {
    const m = monter();
    await m.signaux(0, 300);
    // Pause à 330 s : changement d'état dans la file.
    m.livreur.pause_until = LOIN;
    m.livreur.last_available_at = null;
    await m.minuteur.noterChangement('l1', a(330));
    await m.signaux(360, 900);
    expect(await m.lire(a(900), false)).toBe(330);
    // Reprendre (pause levée), puis disponible (de retour dans la file) à 905 s.
    m.livreur.pause_until = null;
    await m.minuteur.noterChangement('l1', a(902));
    m.livreur.last_available_at = a(905);
    await m.minuteur.noterChangement('l1', a(905));
    await m.signaux(960, 1200);
    expect(await m.lire(a(1200))).toBe(330 + 295);
  });

  it('pause automatique vue au signe de vie : le temps n’est pas compté', async () => {
    const m = monter();
    await m.signaux(0, 120);
    m.livreur.auto_pause_until = a(10_000);
    await m.signaux(180, 600);
    expect(await m.lire(a(600), false)).toBe(120);
  });

  it('en course (sorti de la file en acceptant) : toujours compté', async () => {
    const m = monter();
    await m.signaux(0, 120);
    m.livreur.last_available_at = null;
    m.etat.enCourse = true;
    await m.signaux(180, 600);
    expect(await m.lire(a(600))).toBe(600);
    expect(m.prisma.course.findFirst).toHaveBeenCalled();
  });

  it('hors service sans course : pas compté, sans chercher de course en pause', async () => {
    const m = monter();
    m.livreur.last_available_at = null;
    await m.signaux(0, 300);
    expect(await m.lire(a(300), false)).toBe(0);
    m.prisma.course.findFirst.mockClear();
    m.livreur.pause_until = LOIN;
    await m.signaux(360, 600);
    expect(m.prisma.course.findFirst).not.toHaveBeenCalled();
  });

  it('état passé par la requête authentifiée : pas de relecture en base', async () => {
    const m = monter();
    const etat = { pause_until: null, auto_pause_until: null, last_available_at: a(-60) };
    await m.minuteur.noterSignal('l1', a(0), etat);
    await m.minuteur.noterSignal('l1', a(60), etat);
    expect(m.prisma.deliverer.findUnique).not.toHaveBeenCalled();
    expect(await m.lire(a(60))).toBe(60);
  });

  it('05 h remet à 0 (journée de service de 05 h à 05 h)', async () => {
    const m = monter();
    const veille = new Date('2026-10-25T04:50:00.000Z').getTime();
    const minute = (n: number) => new Date(veille + n * 60_000);
    for (let n = 0; n <= 10; n++) await m.minuteur.noterSignal('l1', minute(n));
    // 04 h 50 → 04 h 59 : 9 minutes ; 05 h 00 ouvre le compte du nouveau jour.
    expect(await m.lire(minute(9))).toBe(9 * 60);
    expect(await m.lire(minute(10))).toBe(0);
    for (let n = 11; n <= 20; n++) await m.minuteur.noterSignal('l1', minute(n));
    expect(await m.lire(minute(20))).toBe(10 * 60);
    expect(m.redis.durees.get('livreur:en-ligne:l1:2026-10-25')).toBe(36 * 60 * 60);
  });

  it('deux serveurs qui reçoivent le même signal ne comptent pas double', async () => {
    const m = monter();
    const autre = m.serveur();
    for (let t = 0; t <= 600; t += 60) {
      await Promise.all([m.minuteur.noterSignal('l1', a(t)), autre.noterSignal('l1', a(t))]);
    }
    expect(await m.lire(a(600))).toBe(600);
    expect(await m.lire(a(600), true, autre)).toBe(600);
  });

  it('deux serveurs, signes de vie entrelacés et légèrement décalés : chaque instant compté une fois', async () => {
    const m = monter();
    const autre = m.serveur();
    for (let t = 0; t <= 600; t += 60) {
      await autre.noterSignal('l1', new Date(a(t).getTime() + 400));
      await m.minuteur.noterSignal('l1', a(t));
    }
    // Le signal de 0,4 s plus tôt arrive après : ignoré ; total de 0,4 s à 600,4 s.
    expect(await m.lire(a(600.4))).toBe(600);
  });

  it('lecture entre deux signes de vie : l’écart en cours compte déjà, sans retour en arrière', async () => {
    const m = monter();
    await m.signaux(0, 60);
    expect(await m.lire(a(90))).toBe(90);
    await m.signaux(120, 120);
    expect(await m.lire(a(120))).toBe(120);
  });

  it('réglage de l’appli fermée : 120 s compte 120 s, pas 130 s ; 0 : 180 s par défaut', async () => {
    const m = monter({ appliFermeeApresS: 120 });
    await m.minuteur.noterSignal('l1', a(0));
    await m.minuteur.noterSignal('l1', a(120));
    await m.minuteur.noterSignal('l1', a(250));
    expect(await m.lire(a(250))).toBe(120);

    const z = monter({ appliFermeeApresS: 0 });
    await z.minuteur.noterSignal('l1', a(0));
    await z.minuteur.noterSignal('l1', a(170));
    await z.minuteur.noterSignal('l1', a(360));
    expect(await z.lire(a(360))).toBe(170);
  });

  it('Redis muet : aucune erreur, temps non compté, lecture null', async () => {
    const m = monter();
    m.redis.panne = true;
    await expect(m.minuteur.noterSignal('l1', a(0))).resolves.toBeUndefined();
    await expect(m.minuteur.noterChangement('l1', a(10))).resolves.toBeUndefined();
    expect(await m.lire(a(60))).toBeNull();
  });

  it('livreur introuvable : rien', async () => {
    const m = monter();
    m.prisma.deliverer.findUnique.mockResolvedValue(null as never);
    await m.minuteur.noterSignal('l1', a(0));
    expect(m.redis.scriptsRecus).toBe(0);
  });

  it('plusieurs livreurs en une seule commande : même valeur que la lecture d’un seul', async () => {
    const m = monter();
    await m.signaux(0, 600);
    const parLivreur = await m.minuteur.lirePlusieurs(
      [
        { id: 'l1', enLigne: true },
        { id: 'jamais-vu', enLigne: true },
      ],
      180,
      a(630),
    );
    expect(m.redis.lecturesGroupees).toBe(1);
    expect(parLivreur?.get('l1')).toBe(await m.lire(a(630)));
    expect(parLivreur?.get('l1')).toBe(630);
    expect(parLivreur?.get('jamais-vu')).toBe(0);
  });

  it('plusieurs livreurs, aucun : rien n’est demandé à Redis ; Redis muet : null', async () => {
    const m = monter();
    expect(await m.minuteur.lirePlusieurs([], 180, a(0))).toEqual(new Map());
    expect(m.redis.lecturesGroupees).toBe(0);
    m.redis.panne = true;
    expect(await m.minuteur.lirePlusieurs([{ id: 'l1', enLigne: true }], 180, a(0))).toBeNull();
  });
});

describe('MinuteurEnLigneListener', () => {
  it('signes de vie et changements d’état partent au minuteur', () => {
    const minuteur = { noterSignal: jest.fn(async () => undefined), noterChangement: jest.fn(async () => undefined) };
    const ecouteur = new MinuteurEnLigneListener(minuteur as never);
    const etat = { pause_until: null, auto_pause_until: null, last_available_at: a(0) };

    ecouteur.onSignal({ delivererId: 'l1', a: a(60).toISOString(), etat });
    ecouteur.onPosition({ delivererId: 'l1', lat: 5.3, lng: -4, heading: null, speedKmh: null, ts: a(65).toISOString(), restaurantId: 'r1' });
    ecouteur.onFile({ delivererId: 'l1', restaurantId: 'r1' });
    ecouteur.onPauseAuto({ delivererId: 'l1', autoPauseUntil: a(900).toISOString(), refusalCount: 3, windowMinutes: 15 });

    expect(minuteur.noterSignal).toHaveBeenNthCalledWith(1, 'l1', a(60), etat);
    expect(minuteur.noterSignal).toHaveBeenNthCalledWith(2, 'l1', a(65));
    expect(minuteur.noterChangement).toHaveBeenCalledTimes(2);
  });
});

describe('GET /deliverers/me/scoring-info : en_ligne et en_ligne_aujourdhui_s', () => {
  const monterInfo = (livreur: Record<string, unknown>, course: unknown = null) => {
    const prisma = {
      deliverer: {
        findUnique: jest.fn(async () => ({
          id: 'l1',
          status: DelivererStatus.ACTIVE,
          is_operational: true,
          restaurant_id: null,
          type_vehicule: null,
          last_location: null,
          last_location_at: null,
          queue_penalty_until: null,
          queue_penalty_positions: 0,
          recent_refusals: [],
          entity_status: EntityStatus.ACTIVE,
          pause_until: null,
          auto_pause_until: null,
          last_available_at: null,
          ...livreur,
        })),
      },
      course: { findFirst: jest.fn(async () => course) },
    };
    const settings = {
      load: jest.fn(async () => ({
        autoPauseRefusalsWindowMin: 15,
        autoPauseRefusalsThreshold: 3,
        appliFermeeApresS: 180,
      })),
    };
    const minuteur = { lire: jest.fn(async () => 1234) };
    const service = new DelivererInfoService(prisma as never, {} as never, settings as never, minuteur as never);
    return { service, minuteur };
  };

  it('en service hors pause : en ligne, secondes du minuteur', async () => {
    const { service, minuteur } = monterInfo({ last_available_at: new Date(Date.now() - 60_000) });
    const vue = await service.getScoringInfo('l1');
    expect(vue).toMatchObject({ en_ligne: true, en_ligne_aujourdhui_s: 1234 });
    expect(minuteur.lire).toHaveBeenCalledWith('l1', true, 180, expect.any(Date));
  });

  it('en course : en ligne ; en pause : pas en ligne', async () => {
    const course = { id: 'c1', reference: 'C-1', statut: 'IN_DELIVERY' };
    expect(await monterInfo({}, course).service.getScoringInfo('l1')).toMatchObject({ en_ligne: true });
    const enPause = monterInfo({ pause_until: new Date(Date.now() + 600_000) });
    expect(await enPause.service.getScoringInfo('l1')).toMatchObject({ en_ligne: false, en_ligne_aujourdhui_s: 1234 });
    expect(enPause.minuteur.lire).toHaveBeenCalledWith('l1', false, 180, expect.any(Date));
  });
});
