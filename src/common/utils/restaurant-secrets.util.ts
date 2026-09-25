import { CHAMPS_SECRETS_RESTAURANT } from 'src/modules/restaurant/constantes/restaurant-public.select';

const SECRETS = new Set<string>(CHAMPS_SECRETS_RESTAURANT);

/** Au-delà, on rend la valeur telle quelle : garde-fou contre un cycle. */
const PROFONDEUR_MAX = 10;

/**
 * Dernier filet avant le socket : retire la clé Turbo et les accès HubRise
 * d'un restaurant, où qu'ils se trouvent dans la charge utile.
 *
 * Le vrai correctif est en amont : les requêtes ne chargent plus le
 * restaurant complet (`RESTAURANT_COMMANDE_SELECT`). Ce filtre rattrape le
 * prochain `include: { restaurant: true }` qui partirait tel quel vers
 * `backoffice_all`, les livreurs ou un client.
 *
 * Copie à l'écriture : sans secret, la charge utile ressort à l'identique,
 * même référence, sans allocation. Seuls les objets simples et les tableaux
 * sont parcourus ; une Date, un Buffer ou un Decimal passent sans être touchés.
 */
export function sansSecretsRestaurant<T>(donnees: T): T {
  return nettoyer(donnees, 0) as T;
}

function nettoyer(valeur: unknown, profondeur: number): unknown {
  if (valeur === null || typeof valeur !== 'object' || profondeur > PROFONDEUR_MAX) {
    return valeur;
  }

  if (Array.isArray(valeur)) {
    let copie: unknown[] | null = null;
    for (let i = 0; i < valeur.length; i++) {
      const avant: unknown = valeur[i];
      const apres = nettoyer(avant, profondeur + 1);
      if (apres !== avant) {
        copie ??= valeur.slice();
        copie[i] = apres;
      }
    }
    return copie ?? valeur;
  }

  const prototype = Object.getPrototypeOf(valeur);
  if (prototype !== Object.prototype && prototype !== null) return valeur;

  const source = valeur as Record<string, unknown>;
  let copie: Record<string, unknown> | null = null;
  for (const cle of Object.keys(source)) {
    if (SECRETS.has(cle)) {
      copie ??= { ...source };
      delete copie[cle];
      continue;
    }
    const avant = source[cle];
    const apres = nettoyer(avant, profondeur + 1);
    if (apres !== avant) {
      copie ??= { ...source };
      copie[cle] = apres;
    }
  }
  return copie ?? valeur;
}
