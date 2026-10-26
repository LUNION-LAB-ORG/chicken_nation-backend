/**
 * Fin du dernier socket de chaque livreur, gardée dans Redis (retour du
 * client du 25/10 : « Appli fermée » affiché pour une appli restée ouverte).
 * La raison socket.io de la fin départage une appli fermée par le livreur
 * (`client namespace disconnect`) d'une connexion coupée (`ping timeout`,
 * `transport close`) : écrite à chaque fin, effacée à chaque connexion, lue
 * en une commande, jamais bloquante.
 */
import { Logger } from '@nestjs/common';

import { EVENEMENT_LIVREUR_CONNECTE, EVENEMENT_LIVREUR_DECONNECTE } from '../utils/evenements-connexion.util';
import {
  DELAI_FINS_SOCKET_MS,
  DUREE_FIN_SOCKET_S,
  FinsSocketLivreursService,
  cleFinSocket,
} from './fins-socket-livreurs.service';

/** Double de Redis : SET avec EX, DEL, MGET ; panne et lenteur à la demande. */
class RedisSimule {
  readonly valeurs = new Map<string, string>();
  readonly durees = new Map<string, number>();
  panne = false;
  lent = false;
  commandes = 0;

  private async passer(): Promise<void> {
    this.commandes++;
    if (this.panne) throw new Error('Connection is closed.');
    if (this.lent) await new Promise(() => undefined);
  }

  async set(cle: string, valeur: string, ex: 'EX', secondes: number): Promise<'OK'> {
    await this.passer();
    expect(ex).toBe('EX');
    this.valeurs.set(cle, valeur);
    this.durees.set(cle, secondes);
    return 'OK';
  }

  async del(cle: string): Promise<number> {
    await this.passer();
    return this.valeurs.delete(cle) ? 1 : 0;
  }

  async mget(...cles: string[]): Promise<(string | null)[]> {
    await this.passer();
    return cles.map((c) => this.valeurs.get(c) ?? null);
  }

  async quit(): Promise<'OK'> {
    return 'OK';
  }
}

const A = '2026-10-25T17:31:00.000Z';

function monter() {
  const redis = new RedisSimule();
  const service = new FinsSocketLivreursService(redis as never);
  const journal = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  return { redis, service, journal };
}

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('FinsSocketLivreursService', () => {
  it('événements du bus interne : la passerelle annonce la déconnexion, la connexion existe déjà', () => {
    expect(EVENEMENT_LIVREUR_DECONNECTE).toBe('livreur.deconnecte');
    expect(EVENEMENT_LIVREUR_CONNECTE).toBe('livreur.connecte');
  });

  it('déconnexion : raison et heure écrites pour 12 h sous `livreur:fin-socket:<id>`, relues en Date', async () => {
    const t = monter();
    await t.service.noterFin({ delivererId: 'd1', raison: 'client namespace disconnect', a: A });

    expect(cleFinSocket('d1')).toBe('livreur:fin-socket:d1');
    expect(DUREE_FIN_SOCKET_S).toBe(43_200);
    expect(t.redis.durees.get('livreur:fin-socket:d1')).toBe(43_200);
    expect(await t.service.lire(['d1', 'd2'])).toEqual(
      new Map([['d1', { raison: 'client namespace disconnect', a: new Date(A) }]]),
    );
  });

  it('nouvelle fin : remplace la précédente ; nouvelle connexion : efface la fin', async () => {
    const t = monter();
    await t.service.noterFin({ delivererId: 'd1', raison: 'client namespace disconnect', a: A });
    await t.service.noterFin({ delivererId: 'd1', raison: 'ping timeout', a: '2026-10-25T17:40:00.000Z' });
    expect((await t.service.lire(['d1']))?.get('d1')?.raison).toBe('ping timeout');

    await t.service.effacer({ delivererId: 'd1' });
    expect(await t.service.lire(['d1'])).toEqual(new Map());
  });

  it('aucun livreur à lire : aucune commande Redis', async () => {
    const t = monter();
    expect(await t.service.lire([])).toEqual(new Map());
    expect(t.redis.commandes).toBe(0);
  });

  it('valeur illisible ou incomplète : ignorée (aucune preuve), les autres sont lues', async () => {
    const t = monter();
    t.redis.valeurs.set(cleFinSocket('casse'), '{pas du json');
    t.redis.valeurs.set(cleFinSocket('sans-heure'), JSON.stringify({ raison: 'ping timeout' }));
    t.redis.valeurs.set(cleFinSocket('heure-fausse'), JSON.stringify({ raison: 'ping timeout', a: 'hier' }));
    await t.service.noterFin({ delivererId: 'bon', raison: 'transport close', a: A });

    expect(await t.service.lire(['casse', 'sans-heure', 'heure-fausse', 'bon'])).toEqual(
      new Map([['bon', { raison: 'transport close', a: new Date(A) }]]),
    );
  });

  it('lireSansSocket : seulement les livreurs sans socket ouvert ; présence inconnue : tous', async () => {
    const t = monter();
    await t.service.noterFin({ delivererId: 'd1', raison: 'ping timeout', a: A });
    await t.service.noterFin({ delivererId: 'd2', raison: 'ping timeout', a: A });

    expect([...((await t.service.lireSansSocket(['d1', 'd2'], new Set(['d2']))) ?? new Map()).keys()]).toEqual(['d1']);
    expect([...((await t.service.lireSansSocket(['d1', 'd2'], null)) ?? new Map()).keys()]).toEqual(['d1', 'd2']);
    const avant = t.redis.commandes;
    expect(await t.service.lireSansSocket(['d1'], new Set(['d1']))).toEqual(new Map());
    expect(t.redis.commandes).toBe(avant);
  });

  it('Redis en panne : écriture et effacement sans erreur, lecture null (aucune preuve), une ligne par minute au journal', async () => {
    const t = monter();
    t.redis.panne = true;

    await expect(t.service.noterFin({ delivererId: 'd1', raison: 'ping timeout', a: A })).resolves.toBeUndefined();
    await expect(t.service.effacer({ delivererId: 'd1' })).resolves.toBeUndefined();
    expect(await t.service.lire(['d1'])).toBeNull();
    expect(await t.service.lire(['d1'])).toBeNull();
    // Trois pannes en rafale : une seule ligne.
    expect(t.journal).toHaveBeenCalledTimes(1);
    expect(String(t.journal.mock.calls[0][0])).not.toMatch(/[—–]/);
  });

  it(`Redis trop lent : lecture abandonnée après ${DELAI_FINS_SOCKET_MS} ms, null`, async () => {
    jest.useFakeTimers();
    const t = monter();
    t.redis.lent = true;

    const lecture = t.service.lire(['d1']);
    jest.advanceTimersByTime(DELAI_FINS_SOCKET_MS);
    expect(await lecture).toBeNull();
    expect(DELAI_FINS_SOCKET_MS).toBe(1500);
  });
});
