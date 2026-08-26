/**
 * Canonicalisation des téléphones CLIENT (table Customer).
 *
 * Format canonique en base : `+<indicatif><numéro>` (E.164, ex. `+2250768566647`)
 * — c'est le format historique créé par le login OTP de l'app (elle envoie
 * l'indicatif choisi + le numéro, préfixés de `+`).
 *
 * ⚠️ Le tunnel d'adhésion du site stockait `225XXXXXXXXXX` (sans `+`) : le
 * match EXACT du login ne retrouvait pas ces comptes → doublon vide, formulaire
 * d'inscription re-affiché, demande de carte invisible dans l'app. D'où :
 *  - `canonicalizeCustomerPhone` : une seule écriture possible ;
 *  - `customerPhoneVariants` : lookups tolérants aux deux graphies le temps
 *    que la migration de fusion ait tout normalisé.
 */

/** `+2250768…`, `2250768…`, `+225 07 68…` → `+2250768…` (E.164). */
export function canonicalizeCustomerPhone(raw: string): string {
  const digits = (raw || '').replace(/\D/g, '');
  if (!digits) return (raw || '').trim();
  return `+${digits}`;
}

/**
 * Variantes à essayer en lookup (canonique d'abord, puis sans `+` pour les
 * lignes héritées de l'adhésion). Sans doublons, ordre stable.
 */
export function customerPhoneVariants(raw: string): string[] {
  const canonical = canonicalizeCustomerPhone(raw);
  const bare = canonical.startsWith('+') ? canonical.slice(1) : canonical;
  const variants = [canonical, bare, (raw || '').trim()];
  return [...new Set(variants.filter(Boolean))];
}

/** Indicatif de la Côte d'Ivoire. */
const INDICATIF_CI = '225';

/**
 * Dix chiffres ivoiriens : mobile (01/05/07, donc `0…`) ou fixe (21/25/27,
 * donc `2…`). Le premier chiffre fait PARTIE du numéro, ce n'est pas un
 * préfixe interurbain qu'on laisse tomber : `+225 07 07 00 00 00` garde son 0.
 */
function estNumeroLocalCI(digits: string): boolean {
  return /^[02]\d{9}$/.test(digits);
}

/**
 * Normalisation E.164 d'un numéro saisi SANS indicatif obligatoire, avec la
 * Côte d'Ivoire par défaut. Renvoie `null` quand le numéro ne peut pas être
 * rendu joignable, plutôt que d'en fabriquer un faux.
 *
 * ⚠️ L'ancienne règle ne reconnaissait comme ivoirien que « dix chiffres
 * commençant par 0 ». Deux trous, silencieux tous les deux :
 *   - un FIXE `27 21 23 45 67` ne recevait pas `+225` et devenait
 *     `+2721234567`, lu comme un numéro sud-africain (+27) ;
 *   - un ancien numéro à HUIT chiffres passait la validation et devenait
 *     `+07070707`. Aucun indicatif pays ne commence par 0 : ce numéro ne peut
 *     rien recevoir, ni WhatsApp ni SMS, et le login de l'application ne le
 *     retrouvera jamais.
 *
 * Sont refusés, explicitement : les huit chiffres de l'ancienne numérotation,
 * `+225` suivi de neuf chiffres (le premier chiffre a été oublié et on ne peut
 * pas deviner 01, 05 ou 07), et tout ce qui commencerait par `+0`.
 */
export function normaliserTelephoneCI(raw: string): string | null {
  if (!raw) return null;

  let cleaned = raw.replace(/[\s.\-()]/g, '');
  if (cleaned.startsWith('00')) cleaned = `+${cleaned.slice(2)}`;
  const digits = cleaned.replace(/\D/g, '');

  if (!/^\d{8,15}$/.test(digits)) return null;

  if (digits.startsWith(INDICATIF_CI)) {
    const local = digits.slice(INDICATIF_CI.length);
    return estNumeroLocalCI(local) ? `+${INDICATIF_CI}${local}` : null;
  }

  if (estNumeroLocalCI(digits)) return `+${INDICATIF_CI}${digits}`;

  // Numéro étranger : l'indicatif fait partie de la saisie.
  if (digits.startsWith('0')) return null;
  if (digits.length < 10) return null;

  return `+${digits}`;
}
