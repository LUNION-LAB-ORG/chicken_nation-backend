/**
 * Nettoyage d'une commande AVANT diffusion large.
 *
 * Les événements de commande partent dans la room `restaurant_{id}`, que les
 * LIVREURS affectés à ce restaurant rejoignent eux aussi (voir `AppGateway`).
 * Or le code de récupération est la preuve de la remise : un livreur qui le lit
 * peut valider une livraison sans avoir rencontré le client.
 *
 * À appliquer sur tout `emitToRestaurant` et `emitToBackoffice` portant une
 * commande. Le canal privé du client, lui, garde le champ : il en est le
 * destinataire.
 */
export function sanitizeOrderForBroadcast<T>(order: T): T {
  if (!order || typeof order !== 'object') return order;
  const { recovery_code: _ignore, ...reste } = order as Record<string, unknown>;
  void _ignore;
  return reste as T;
}
