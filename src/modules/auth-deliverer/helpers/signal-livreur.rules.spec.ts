/**
 * Signe de vie (au plus une écriture par minute) et protocole de l'appli
 * (en-tête `x-deli-protocole`), relevés à chaque requête authentifiée.
 */
import { JwtDelivererStrategy } from '../strategies/jwt-deliverer.strategy';
import {
  ENTETE_PROTOCOLE_APPLI,
  lireProtocoleAppli,
  majSignalLivreur,
} from './signal-livreur.rules';

const MAINTENANT = new Date('2026-10-22T14:00:00.000Z');
const avant = (s: number) => new Date(MAINTENANT.getTime() - s * 1000);

describe('lireProtocoleAppli', () => {
  it('nouvelle appli : 2', () => {
    expect(lireProtocoleAppli('2')).toBe(2);
    expect(lireProtocoleAppli(['2'])).toBe(2);
  });

  it('en-tête absent ou illisible : ancienne appli (1)', () => {
    expect(lireProtocoleAppli(undefined)).toBe(1);
    expect(lireProtocoleAppli('')).toBe(1);
    expect(lireProtocoleAppli('deux')).toBe(1);
    expect(lireProtocoleAppli('0')).toBe(1);
  });
});

describe('majSignalLivreur', () => {
  it('premier signal : écrit le signal et le protocole', () => {
    expect(majSignalLivreur({ dernier_signal_at: null, protocole_appli: null }, 2, MAINTENANT)).toEqual({
      dernier_signal_at: MAINTENANT,
      protocole_appli: 2,
    });
  });

  it('signal de moins d’une minute, même protocole : rien à écrire', () => {
    expect(
      majSignalLivreur({ dernier_signal_at: avant(59), protocole_appli: 2 }, 2, MAINTENANT),
    ).toBeNull();
  });

  it('une minute écoulée : nouvelle écriture', () => {
    expect(
      majSignalLivreur({ dernier_signal_at: avant(60), protocole_appli: 2 }, 2, MAINTENANT),
    ).toEqual({ dernier_signal_at: MAINTENANT, protocole_appli: 2 });
  });

  it('le protocole change (mise à jour de l’appli) : écrit tout de suite', () => {
    expect(
      majSignalLivreur({ dernier_signal_at: avant(5), protocole_appli: 1 }, 2, MAINTENANT),
    ).toEqual({ dernier_signal_at: MAINTENANT, protocole_appli: 2 });
  });
});

describe('JwtDelivererStrategy.validate', () => {
  const monter = (livreur: Record<string, unknown>) => {
    const prisma = {
      deliverer: {
        findUnique: jest.fn(async () => livreur),
        update: jest.fn(async () => ({ id: livreur.id })),
      },
    };
    const events = { emit: jest.fn() };
    const strategie = new JwtDelivererStrategy(
      { get: () => 'secret-essai' } as never,
      prisma as never,
      events as never,
    );
    return { strategie, prisma, events };
  };
  const requete = (protocole?: string) =>
    ({ headers: protocole ? { [ENTETE_PROTOCOLE_APPLI]: protocole } : {} }) as never;

  beforeEach(() => jest.useFakeTimers({ now: MAINTENANT, doNotFake: ['nextTick', 'setImmediate'] }));
  afterEach(() => jest.useRealTimers());

  it('note le signe de vie et le protocole, sans exposer les secrets', async () => {
    const { strategie, prisma } = monter({
      id: 'livreur-1',
      password: 'hache',
      refresh_token: 'jeton',
      dernier_signal_at: null,
      protocole_appli: null,
    });

    const livreur = await strategie.validate(requete('2'), { sub: 'livreur-1', type: 'deliverer' });

    expect(livreur).not.toHaveProperty('password');
    expect(livreur).not.toHaveProperty('refresh_token');
    expect(prisma.deliverer.update).toHaveBeenCalledWith({
      where: { id: 'livreur-1' },
      data: { dernier_signal_at: MAINTENANT, protocole_appli: 2 },
      select: { id: true },
    });
  });

  it('signal récent et même protocole : aucune écriture', async () => {
    const { strategie, prisma } = monter({
      id: 'livreur-1',
      dernier_signal_at: avant(20),
      protocole_appli: 1,
    });
    await strategie.validate(requete(), { sub: 'livreur-1', type: 'deliverer' });
    expect(prisma.deliverer.update).not.toHaveBeenCalled();
  });

  it('signe de vie écrit : part au minuteur « en ligne » avec l’état d’avant la requête', async () => {
    const entree = avant(600);
    const { strategie, events } = monter({
      id: 'livreur-1',
      dernier_signal_at: avant(61),
      protocole_appli: 4,
      pause_until: null,
      auto_pause_until: null,
      last_available_at: entree,
    });
    await strategie.validate(requete('4'), { sub: 'livreur-1', type: 'deliverer' });
    expect(events.emit).toHaveBeenCalledWith('deliverer:signal', {
      delivererId: 'livreur-1',
      a: MAINTENANT.toISOString(),
      etat: { pause_until: null, auto_pause_until: null, last_available_at: entree },
    });
  });

  it('rien d’écrit : rien pour le minuteur', async () => {
    const { strategie, events } = monter({ id: 'livreur-1', dernier_signal_at: avant(20), protocole_appli: 4 });
    await strategie.validate(requete('4'), { sub: 'livreur-1', type: 'deliverer' });
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('une écriture qui échoue ne refuse pas la requête', async () => {
    const { strategie, prisma } = monter({ id: 'livreur-1', dernier_signal_at: null, protocole_appli: null });
    prisma.deliverer.update.mockRejectedValue(new Error('base indisponible'));
    await expect(
      strategie.validate(requete('2'), { sub: 'livreur-1', type: 'deliverer' }),
    ).resolves.toMatchObject({ id: 'livreur-1' });
  });
});
