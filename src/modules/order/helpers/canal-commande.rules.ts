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
 * Colonne « Source » des exports Excel : « Site web », « Appli » ou
 * « Manuel » (saisie du personnel : centre d'appels, comptoir, HubRise).
 * « Manuel » plutôt que « Téléphone », choix de l'équipe du 02/10 : une
 * commande saisie à la main n'est pas forcément un appel.
 *
 * Le site se lit sur `channel`. Le reste garde la lecture par `auto`, qui
 * couvre aussi les commandes antérieures au canal (`channel` vide) et la
 * commande de l'application reprise au téléphone (`auto` repassé à false).
 * Jumeau du libellé du backoffice (features/orders/utils/canal-commande.ts).
 */
export function libelleSource(commande: {
  channel?: OrderChannel | string | null;
  auto?: boolean | null;
}): string {
  // Commande du site reprise au téléphone (`auto` faux) : « Manuel », comme
  // toute commande passée par le personnel (choix de l'équipe du 03/10).
  if (commande.channel === OrderChannel.WEB && commande.auto !== false) return 'Site web';
  if (commande.channel === OrderChannel.RESTAURANT) return 'Manuel';
  return commande.auto ? 'Appli' : 'Manuel';
}
