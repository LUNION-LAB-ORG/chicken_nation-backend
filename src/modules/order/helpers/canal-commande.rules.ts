import { OrderChannel, UserType } from '@prisma/client';

/**
 * CANAL D'UNE COMMANDE (02/10/2026).
 *
 * `Order.channel` dit d'où vient chaque commande. `createv2` le reçoit du
 * contrôleur (APP ou WEB, selon l'en-tête du site). Ce fichier règle l'autre
 * entrée, `OrderService.create()`, que partagent deux routes :
 *
 *  - POST /orders, l'ancienne route CLIENT des applications : pas d'auteur
 *    (`user_id` neutralisé par le contrôleur) → APP ;
 *  - POST /orders/create, la saisie du PERSONNEL : l'auteur est pris du jeton.
 *    Un compte de point de vente (type RESTAURANT : caissier, gérant) vend au
 *    comptoir → RESTAURANT. Les autres (centre d'appels, administrateur) →
 *    CALL_CENTER.
 *
 * Avant ce correctif, toute saisie du personnel partait CALL_CENTER : les
 * ventes au comptoir auraient gonflé le centre d'appels dans un rapport par
 * canal.
 */
export function canalDeSaisie(
  user_id: string | null | undefined,
  auteur?: { type?: UserType | string | null } | null,
): OrderChannel {
  if (!user_id) return OrderChannel.APP;
  return auteur?.type === UserType.RESTAURANT ? OrderChannel.RESTAURANT : OrderChannel.CALL_CENTER;
}

/**
 * Colonne « Source » des exports Excel.
 *
 * Le site et le comptoir se lisent sur `channel`. Le reste garde l'ancienne
 * lecture par `auto`, qui couvre aussi les commandes antérieures au canal
 * (`channel` vide) et la commande de l'application reprise au téléphone
 * (`auto` repassé à false).
 */
export function libelleSource(commande: {
  channel?: OrderChannel | string | null;
  auto?: boolean | null;
}): string {
  if (commande.channel === OrderChannel.WEB) return 'Site web';
  if (commande.channel === OrderChannel.RESTAURANT) return 'Restaurant';
  return commande.auto ? 'Appli' : 'Téléphone';
}
