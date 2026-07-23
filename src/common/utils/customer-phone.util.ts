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
