/**
 * Construction des URL publiques du serveur, à partir de `BASE_URL`.
 *
 * Deux pièges se sont déjà refermés sur ce sujet, d'où cet utilitaire unique.
 *
 * 1. `BASE_URL` n'a PAS la même forme partout. En production elle porte déjà le
 *    préfixe de l'API (`https://api-private.chicken-nation.com/api/v1`), sur un
 *    poste de développement elle ne le porte pas. Ajouter `/api/v1` sans
 *    regarder donne `…/api/v1/api/v1/…`, donc un 404. C'est ce qui a fait
 *    remplacer les pastilles de la vignette d'itinéraire par les épingles
 *    rouges de Google, sans une ligne d'erreur.
 *
 * 2. `path.join` ne sert PAS à assembler une URL : il normalise `//` en `/`,
 *    donc `https://hôte` devient `https:/hôte`. Toutes les icônes de
 *    notification et de statistiques étaient construites ainsi.
 *
 * ⚠️ Le dossier `uploads` est servi HORS du préfixe (`useStaticAssets` avec
 * `prefix: '/uploads'` dans `main.ts`). Une ressource statique se construit donc
 * avec `urlPublique`, une route d'API avec `urlApi`.
 */

/** Préfixe global de l'API, posé dans `main.ts`. */
const PREFIXE_API = '/api/v1';

/**
 * Racine du serveur, sans barre finale et SANS le préfixe de l'API, quelle que
 * soit la forme de `BASE_URL`.
 */
export function racinePublique(): string {
  return (process.env.BASE_URL ?? '')
    .trim()
    .replace(/\/+$/, '')
    .replace(new RegExp(`${PREFIXE_API}$`), '');
}

/** URL d'une ressource servie à la racine, `uploads/...` par exemple. */
export function urlPublique(chemin: string): string {
  const racine = racinePublique();
  if (!racine) return '';
  return `${racine}/${chemin.replace(/^\/+/, '')}`;
}

/** URL d'une route de l'API, préfixe compris et jamais dédoublé. */
export function urlApi(chemin: string): string {
  const racine = racinePublique();
  if (!racine) return '';
  return `${racine}${PREFIXE_API}/${chemin.replace(/^\/+/, '')}`;
}

/**
 * Même normalisation, mais à partir d'une base FOURNIE plutôt que de
 * l'environnement : HubRise lit son `base_url` dans les réglages, avec repli
 * sur `BASE_URL`. La valeur peut donc porter le préfixe, ou non.
 */
export function urlApiDepuis(base: string, chemin: string): string {
  const racine = (base ?? '')
    .trim()
    .replace(/\/+$/, '')
    .replace(new RegExp(`${PREFIXE_API}$`), '');
  if (!racine) return '';
  return `${racine}${PREFIXE_API}/${chemin.replace(/^\/+/, '')}`;
}
