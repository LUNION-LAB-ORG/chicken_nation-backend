import type { Cache } from 'cache-manager';

import { avantDelai } from 'src/modules/auth/helpers/file-par-cle.helper';

/**
 * Délai d'une lecture ou d'une écriture du cache (Redis) sur le chemin du
 * dispatch, des trajets et des frais : 400 ms. Pendant une coupure de Redis,
 * le client garde les commandes en file (reconnexion sans fin) au lieu
 * d'échouer : sans délai, un passage du planificateur, le choix d'un livreur
 * ou la création d'une commande attendaient le retour de Redis.
 */
export const DELAI_CACHE_MS = 400;

/** Lecture du cache qui ne lève jamais : Redis coupé, lent ou en erreur = absent. */
export async function lireCacheBorne<T>(cache: Cache, cle: string, ms = DELAI_CACHE_MS): Promise<T | undefined> {
  try {
    return (await avantDelai(cache.get<T>(cle), ms)) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Écriture du cache qui ne lève jamais.
 *
 * @returns l'erreur (délai dépassé, Redis en erreur) si elle n'a pas abouti, sinon null.
 */
export async function ecrireCacheBorne(
  cache: Cache,
  cle: string,
  valeur: unknown,
  ttl: number,
  ms = DELAI_CACHE_MS,
): Promise<Error | null> {
  try {
    await avantDelai(cache.set(cle, valeur, ttl), ms);
    return null;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}
