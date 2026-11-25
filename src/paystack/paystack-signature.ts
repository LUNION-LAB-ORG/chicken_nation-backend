import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * SIGNATURE DES WEBHOOKS PAYSTACK (docs/payments/webhooks, lue le 25/11).
 *
 * Nouveau schéma : `Paystack-Signature: t=<secondes>,v1=whk_<id>:<hex>` (un ou
 * plusieurs v1). HMAC SHA512 de `${t}.${corps brut}` avec le secret de
 * signature ENTIER (whsec_ compris), comparé en temps constant à chaque v1 ;
 * `t` à plus de 300 s de l'horloge du serveur : refusé (rejeu).
 *
 * Ancien schéma, gardé tant que les événements ne portent pas le nouveau :
 * `x-paystack-signature` = HMAC SHA512 hexadécimal du corps brut avec la clé
 * secrète.
 *
 * Corps tel que reçu, jamais resérialisé. Fonctions pures.
 */
export const FENETRE_SIGNATURE_S = 300;
const HEX_512 = /^[0-9a-f]{128}$/i;

const egalTempsConstant = (attendu: Buffer, recuHex: string): boolean => {
  const recu = Buffer.from(recuHex, 'hex');
  return recu.length === attendu.length && timingSafeEqual(recu, attendu);
};

export function signatureNouvelleValide(
  corps: string,
  entete: string | undefined,
  secrets: string[],
  maintenantS: number,
): boolean {
  if (typeof entete !== 'string' || !secrets.length) return false;
  const champs = entete.split(',').map((c) => c.trim());
  const t = champs.find((c) => c.startsWith('t='))?.slice(2) ?? '';
  if (!/^\d{1,12}$/.test(t) || Math.abs(maintenantS - Number(t)) > FENETRE_SIGNATURE_S) return false;
  const signatures = champs
    .filter((c) => c.startsWith('v1='))
    .map((c) => c.slice(3))
    .map((v) => v.slice(v.indexOf(':') + 1))
    .filter((h) => HEX_512.test(h));
  if (!signatures.length) return false;
  let valide = false;
  for (const secret of secrets) {
    const attendu = createHmac('sha512', secret).update(`${t}.${corps}`, 'utf8').digest();
    for (const h of signatures) if (egalTempsConstant(attendu, h)) valide = true;
  }
  return valide;
}

export function signatureAncienneValide(corps: string, entete: string | undefined, cles: string[]): boolean {
  if (typeof entete !== 'string' || !HEX_512.test(entete.trim()) || !cles.length) return false;
  let valide = false;
  for (const cle of cles) {
    const attendu = createHmac('sha512', cle).update(corps, 'utf8').digest();
    if (egalTempsConstant(attendu, entete.trim())) valide = true;
  }
  return valide;
}

/** IP de la requête dans la liste (IPv4 vue en IPv6 `::ffff:` ramenée). Liste vide : aucun contrôle. */
export function ipAutorisee(ip: string | undefined | null, liste: string[]): boolean {
  if (!liste.length) return true;
  if (typeof ip !== 'string' || !ip) return false;
  return liste.includes(ip.trim().replace(/^::ffff:/i, ''));
}
