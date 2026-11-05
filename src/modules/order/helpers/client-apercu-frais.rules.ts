/**
 * Client dont dépendent les offres de l'aperçu des frais de livraison.
 *
 *  - client connecté : lui-même, quel que soit le paramètre reçu ;
 *  - personnel : le client de la commande en cours de saisie, s'il y en a un ;
 *  - invité : personne. Le paramètre est ignoré, sinon n'importe qui saurait
 *    qui est étudiant ou VIP à partir d'un identifiant.
 */
export function clientDeLApercu(
  principal: { id?: string; role?: unknown } | null | undefined,
  customerId?: string,
): string | null {
  if (!principal) return null;
  if ('role' in principal) return customerId ?? null;
  return principal.id ?? null;
}
