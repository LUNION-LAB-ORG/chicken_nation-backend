/**
 * Signature des callbacks (webhooks) HubRise.
 *
 * Documentation HubRise (page Callbacks) : chaque événement porte l'en-tête
 * `X-HubRise-Hmac-SHA256`, HMAC-SHA256 en hexadécimal du corps BRUT, calculé
 * avec le `client_secret` du client OAuth.
 *
 * ⚠️ L'ancien code lisait `x-hubrise-hmac` (jamais envoyé) avec
 * `HUBRISE_WEBHOOK_SECRET` (qui n'est pas la clé de HubRise) : comme la
 * vérification ne tournait que si l'en-tête était présent, elle était
 * TOUJOURS sautée et la route acceptait n'importe quel POST.
 *
 * Fonction pure, testée dans `signature-webhook.util.spec.ts`.
 */

import { createHmac, timingSafeEqual } from 'crypto';

/** En-tête de signature HubRise (Node le livre en minuscules). */
export const ENTETE_SIGNATURE_HUBRISE = 'x-hubrise-hmac-sha256';

const HEX_SHA256 = /^[0-9a-fA-F]{64}$/;

/**
 * Vrai seulement si l'en-tête est la signature exacte du corps brut.
 * Secret vide, en-tête ou corps absent : faux (jamais « valide par défaut »).
 * Comparaison à temps constant.
 */
export function verifierSignatureHubrise(
  corpsBrut: Buffer | undefined,
  entete: string | undefined,
  secret: string,
): boolean {
  if (!secret || !entete || !corpsBrut || !Buffer.isBuffer(corpsBrut)) return false;

  const valeur = entete.trim();
  if (!HEX_SHA256.test(valeur)) return false;

  const attendue = createHmac('sha256', secret).update(corpsBrut).digest();
  const recue = Buffer.from(valeur, 'hex');

  return recue.length === attendue.length && timingSafeEqual(recue, attendue);
}
