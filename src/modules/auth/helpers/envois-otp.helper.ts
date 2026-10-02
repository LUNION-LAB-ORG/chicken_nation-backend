/**
 * Plafonds d'ENVOI des codes de connexion client (Twilio : WhatsApp, et SMS
 * en secours quand WhatsApp échoue, par exemple pour un numéro sans WhatsApp).
 *
 * `POST /auth/customer/login` est public et chaque appel coûte un message
 * Twilio. Le délai de 30 s par numéro ne limite qu'un numéro à la fois : en
 * changeant de numéro à chaque appel, un script pouvait déclencher des envois
 * sans limite (facture Twilio, et fraude au « SMS pumping » par la bascule
 * SMS, même si les clients reçoivent leur code sur WhatsApp). L'ouverture de
 * la commande sur le site web rend ce formulaire trivial à automatiser.
 *
 * Trois barrières, de la plus fine à la plus large :
 *  - par numéro : MAX_ENVOIS_PAR_NUMERO codes par heure ;
 *  - par adresse IP : ThrottlerGuard sur la route (complément seulement,
 *    `trust proxy` rend l'IP falsifiable) ;
 *  - au total : plafond horaire global, réglable par OTP_ENVOIS_MAX_PAR_HEURE.
 *    C'est le filet qui borne la facture quoi qu'il arrive.
 *
 * Fonctions pures : les compteurs vivent dans le cache (Redis), le service les
 * lit, appelle ces fonctions et réécrit.
 */

export const MAX_ENVOIS_PAR_NUMERO = 5;
export const FENETRE_ENVOIS_MS = 60 * 60 * 1000; // 1 h
export const MAX_ENVOIS_GLOBAL_PAR_DEFAUT = 400;

export const MESSAGE_TROP_DE_CODES_NUMERO =
  'Trop de codes demandés pour ce numéro. Réessayez dans une heure.';
export const MESSAGE_TROP_DE_CODES_GLOBAL =
  "L'envoi des codes est momentanément saturé. Réessayez dans quelques minutes.";
export const MESSAGE_TROP_DE_DEMANDES_IP =
  'Trop de demandes de code. Réessayez dans une minute.';

export interface CompteurEnvois {
  envois: number;
  /** Début de la fenêtre (horodatage en millisecondes). */
  depuis: number;
}

export function cleEnvoisNumero(telephone: string): string {
  return `otp-envois:numero:${String(telephone ?? '').replace(/\D/g, '')}`;
}

export const CLE_ENVOIS_GLOBAL = 'otp-envois:global';

/** Plafond global lu dans l'environnement ; toute valeur invalide donne le défaut. */
export function plafondGlobal(valeur: string | undefined): number {
  const n = Number(valeur);
  return Number.isInteger(n) && n > 0 ? n : MAX_ENVOIS_GLOBAL_PAR_DEFAUT;
}

/** Relit une valeur du cache ; toute forme inattendue vaut « aucun envoi ». */
export function lireCompteur(valeur: unknown, maintenant: number): CompteurEnvois | null {
  if (!valeur || typeof valeur !== 'object') return null;
  const { envois, depuis } = valeur as Record<string, unknown>;
  if (typeof envois !== 'number' || !Number.isFinite(envois) || envois < 0) return null;
  if (typeof depuis !== 'number' || !Number.isFinite(depuis)) return null;
  if (maintenant - depuis >= FENETRE_ENVOIS_MS) return null; // fenêtre écoulée
  return { envois, depuis };
}

export function plafondAtteint(compteur: CompteurEnvois | null, max: number): boolean {
  return (compteur?.envois ?? 0) >= max;
}

/** Compteur après un envoi, et durée de vie restante de la fenêtre pour le cache. */
export function apresEnvoi(
  compteur: CompteurEnvois | null,
  maintenant: number,
): { compteur: CompteurEnvois; ttlMs: number } {
  const depuis = compteur?.depuis ?? maintenant;
  return {
    compteur: { envois: (compteur?.envois ?? 0) + 1, depuis },
    ttlMs: Math.max(1000, depuis + FENETRE_ENVOIS_MS - maintenant),
  };
}
