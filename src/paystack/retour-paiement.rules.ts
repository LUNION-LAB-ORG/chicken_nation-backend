/**
 * RETOUR DU CLIENT APRÈS LA PAGE DE PAIEMENT PAYSTACK (25/11). Fonctions pures.
 *
 * Paystack renvoie le navigateur vers `callback_url`, en y ajoutant
 * `trxref` et `reference`. L'appli : une page du serveur qui renvoie vers un
 * lien profond de l'appli (la fenêtre de paiement se ferme). Le site : sa
 * page de suivi de la commande.
 *
 * Le lien profond vient de l'appli : il n'est suivi que s'il a le schéma de
 * l'appli (jamais une adresse web quelconque, sinon la page servirait de
 * redirection ouverte).
 */

const API_PAR_DEFAUT = 'https://api-private.chicken-nation.com';
const SITE_PAR_DEFAUT = 'https://www.chicken-nation.com';

export function schemaAppli(): string {
  return (process.env.APP_DEEPLINK_SCHEME || 'chickennation').trim().toLowerCase();
}

/** Lien profond accepté : schéma de l'appli (et Expo hors production), sans identifiants ni retour à la ligne. */
export function lienProfondAccepte(vers: unknown, production = process.env.NODE_ENV === 'production'): string | null {
  if (typeof vers !== 'string') return null;
  const v = vers.trim();
  if (!v || v.length > 300 || /[\s"'<>\\]/.test(v)) return null;
  const m = /^([a-z][a-z0-9+.-]*):\/\//i.exec(v);
  if (!m) return null;
  const schema = m[1].toLowerCase();
  const permis = [schemaAppli(), ...(production ? [] : ['exp', 'exps'])];
  if (!permis.includes(schema)) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/]*@/i.test(v)) return null;
  return v;
}

/** Lien vers lequel la page de retour renvoie : lien profond + référence de la tentative. */
export function lienRetourAppli(vers: unknown, reference: string, production?: boolean): string | null {
  const lien = lienProfondAccepte(vers, production);
  if (!lien) return null;
  if (!reference) return lien;
  return `${lien}${lien.includes('?') ? '&' : '?'}reference=${encodeURIComponent(reference)}`;
}

function base(brute: string | undefined, defaut: string): string {
  const b = (brute || defaut).trim().replace(/\/+$/, '');
  return /^https?:\/\//.test(b) ? b : defaut;
}

/** callback_url pour l'appli : la page de retour du serveur, avec le lien profond à suivre. */
export function callbackAppli(vers: string): string {
  return `${base(process.env.API_PUBLIC_URL, API_PAR_DEFAUT)}/api/v1/paystack/retour?vers=${encodeURIComponent(vers)}`;
}

/** callback_url pour le site : la page de suivi de la commande. */
export function callbackSite(orderId: string): string {
  return `${base(process.env.SITE_PUBLIC_URL, SITE_PAR_DEFAUT)}/fr/commander/${encodeURIComponent(orderId)}`;
}
