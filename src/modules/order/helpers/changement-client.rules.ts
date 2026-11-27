/**
 * Changer le client d'une commande (27/11).
 *
 * Le centre d'appels corrige une commande passée au mauvais nom : autre
 * numéro, autre nom. La commande est alors rattachée au client qui porte ce
 * numéro (créé par le back office s'il est nouveau), et le nom, le téléphone
 * et le courriel inscrits sur la commande suivent.
 *
 * Refusé quand l'ancien client a engagé sur cette commande quelque chose qui
 * lui est propre : un coupon (décision du 25/09), des points dépensés, un
 * cadeau, ou des points déjà gagnés. Les laisser sur la commande d'un autre
 * fausserait son compte ; il faut annuler (tout lui est rendu) et recréer.
 *
 * Fonctions pures, sans base ni réseau.
 */

export const REFUS_CLIENT_COUPON =
  "Le client d'une commande avec un code promo ou un bon ne peut pas être changé. Annulez la commande et créez-en une nouvelle.";

export const REFUS_CLIENT_FIDELITE =
  "Le client d'une commande qui a utilisé ou rapporté des points ou un cadeau ne peut pas être changé. Annulez la commande et créez-en une nouvelle.";

/** La modification demande-t-elle un AUTRE client que celui de la commande ? */
export function changeDeClient(
  clientActuel: string | null | undefined,
  clientDemande: string | null | undefined,
): boolean {
  return !!clientDemande && clientDemande !== clientActuel;
}

export interface LiensClientCommande {
  /** Code promo ou bon posé sur la commande. */
  codePromo?: string | null;
  /** Points de fidélité dépensés sur la commande. */
  pointsUtilises?: number | null;
  /** Écritures de points rattachées à la commande (gagnés, dépensés). */
  mouvementsFidelite?: number;
  /** Récompenses rattachées à la commande (cadeau utilisé, gain). */
  recompenses?: number;
}

/** Motif de refus du changement de client, ou `null` s'il est possible. */
export function motifRefusChangementClient(liens: LiensClientCommande): string | null {
  if (liens.codePromo) return REFUS_CLIENT_COUPON;
  if (
    (liens.pointsUtilises ?? 0) > 0 ||
    (liens.mouvementsFidelite ?? 0) > 0 ||
    (liens.recompenses ?? 0) > 0
  ) {
    return REFUS_CLIENT_FIDELITE;
  }
  return null;
}
