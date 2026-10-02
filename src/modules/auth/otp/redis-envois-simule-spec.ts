/**
 * Redis simulé en mémoire pour les tests d'EnvoisOtpService : les seules
 * commandes qu'il emploie (SET … PX … NX, PTTL, DEL, MULTI/EXEC avec SET, INCR
 * et DECR), avec l'expiration des clés sur une horloge que le test avance.
 *
 * Nom en « -spec.ts » : exclu de la construction sans être pris pour une suite
 * par Jest (voir table-tentatives-simulee-spec.ts).
 *
 * Chaque commande, et chaque transaction, rend la main une fois avant de
 * s'exécuter d'un bloc, comme un aller et retour vers Redis : des appels
 * lancés ensemble s'entrelacent entre deux commandes, jamais au milieu d'une.
 */

import type { ClientRedisEnvois } from './redis-envois.provider';

interface Entree {
  valeur: string;
  /** Horodatage d'expiration, `null` si la clé n'expire pas. */
  expireA: number | null;
}

type Resultat = [Error | null, unknown];

const allerRetour = () => Promise.resolve();

export function creerRedisSimule() {
  const cles = new Map<string, Entree>();
  let decalage = 0;
  let enPanne = false;

  const maintenant = () => Date.now() + decalage;

  function lire(cle: string): Entree | undefined {
    const entree = cles.get(cle);
    if (entree && entree.expireA !== null && entree.expireA <= maintenant()) {
      cles.delete(cle);
      return undefined;
    }
    return entree;
  }

  function set(cle: string, valeur: string, ...options: (string | number)[]): 'OK' | null {
    const px = options.indexOf('PX');
    const duree = px >= 0 ? Number(options[px + 1]) : null;
    if (options.includes('NX') && lire(cle)) return null;
    cles.set(cle, { valeur: String(valeur), expireA: duree === null ? null : maintenant() + duree });
    return 'OK';
  }

  function ajouter(cle: string, pas: number): number {
    const entree = lire(cle);
    const actuelle = entree ? Number(entree.valeur) : 0;
    if (!Number.isInteger(actuelle)) {
      throw new Error('ERR value is not an integer or out of range');
    }
    const suivante = actuelle + pas;
    // Comme Redis : INCR et DECR gardent l'expiration, et une clé absente
    // naît SANS expiration.
    cles.set(cle, { valeur: String(suivante), expireA: entree?.expireA ?? null });
    return suivante;
  }

  async function commande<T>(executer: () => T): Promise<T> {
    await allerRetour();
    if (enPanne) throw new Error('Connection is closed.');
    return executer();
  }

  const client = {
    set: jest.fn((cle: string, valeur: string, ...options: (string | number)[]) =>
      commande(() => set(cle, valeur, ...options)),
    ),
    pttl: jest.fn((cle: string) =>
      commande(() => {
        const entree = lire(cle);
        if (!entree) return -2;
        return entree.expireA === null ? -1 : entree.expireA - maintenant();
      }),
    ),
    del: jest.fn((cle: string) => commande(() => (lire(cle) && cles.delete(cle) ? 1 : 0))),
    multi: jest.fn(() => {
      const file: (() => unknown)[] = [];
      const transaction = {
        set: (cle: string, valeur: string, ...options: (string | number)[]) => {
          file.push(() => set(cle, valeur, ...options));
          return transaction;
        },
        incr: (cle: string) => {
          file.push(() => ajouter(cle, 1));
          return transaction;
        },
        decr: (cle: string) => {
          file.push(() => ajouter(cle, -1));
          return transaction;
        },
        exec: () =>
          commande((): Resultat[] =>
            file.map((executer) => {
              try {
                return [null, executer()];
              } catch (erreur) {
                return [erreur as Error, null];
              }
            }),
          ),
      };
      return transaction;
    }),
    quit: jest.fn(async () => 'OK'),
  };

  return {
    client: client as unknown as ClientRedisEnvois,
    espions: client,
    /** Valeur brute d'une clé encore valide. */
    valeur: (cle: string) => lire(cle)?.valeur ?? null,
    /** Durée de vie restante (ms), -1 sans expiration, -2 si absente. */
    resteMs: (cle: string) => {
      const entree = lire(cle);
      if (!entree) return -2;
      return entree.expireA === null ? -1 : entree.expireA - maintenant();
    },
    /** Pose une valeur brute (état laissé par une version précédente, par exemple). */
    poser: (cle: string, valeur: string, dureeMs: number | null) =>
      cles.set(cle, { valeur, expireA: dureeMs === null ? null : maintenant() + dureeMs }),
    avancer: (ms: number) => {
      decalage += ms;
    },
    panne: (oui: boolean) => {
      enPanne = oui;
    },
  };
}
