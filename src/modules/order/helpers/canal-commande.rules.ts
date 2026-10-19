import { OrderChannel, OrderStatus, Prisma, UserType } from '@prisma/client';

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
 * Colonne « Source » des exports Excel : « Appli » ou « Téléphone », comme
 * avant le 02/10. Demande de l'utilisateur du 03/10 : revenir au libellé
 * historique. Une commande du site reste « Appli » (elle est passée par le
 * client, `auto` vrai), et toute saisie du personnel reste « Téléphone »,
 * jamais « Manuel ». Le canal enregistré (`channel`) ne change pas et reste
 * disponible pour les statistiques ; l'écran du backoffice garde son propre
 * libellé (features/orders/utils/canal-commande.ts).
 */
export function libelleSource(commande: {
  channel?: OrderChannel | string | null;
  auto?: boolean | null;
}): string {
  return commande.auto ? 'Appli' : 'Téléphone';
}

// ---------------------------------------------------------------------------
// Filtre « source » de la liste des commandes (demande du 19/10)
// ---------------------------------------------------------------------------

/**
 * Valeurs du paramètre de requête facultatif `source` de GET /orders, de
 * GET /orders/export-report-to-excel et de GET /orders/export-delivery-pivot :
 *
 *  - `site` : « Site web », channel WEB et `auto` vrai ;
 *  - `appli` : « Par application », `auto` vrai et channel autre que WEB,
 *    channel vide compris (commandes antérieures au canal) ;
 *  - `telephone` : « Par téléphone », `auto` faux, saisie du personnel. Une
 *    commande du site reprise au téléphone y va (`auto` repassé à faux,
 *    `channel` resté WEB), comme l'écran l'affiche « Manuel ».
 *
 * Jumeau de `libelleCanal` du backoffice
 * (features/orders/utils/canal-commande.ts) et de `canalDeCommande` des
 * statistiques : « Site web » = WEB, « Par application » = APP, « Par
 * téléphone » = CALL_CENTER.
 *
 * Sans `source`, rien ne change : le filtre historique `auto` s'applique. Un
 * backoffice plus ancien, qui envoie seulement `auto=true`, garde l'ancien
 * résultat (site et application ensemble). Quand `source` est là, il prime
 * sur `auto`.
 */
export const SOURCES_COMMANDE = ['site', 'appli', 'telephone'] as const;

export type SourceCommande = (typeof SOURCES_COMMANDE)[number];

/** Source d'une commande en mémoire. Même règle que `conditionSource`. */
export function sourceDeCommande(commande: {
  channel?: OrderChannel | string | null;
  auto?: boolean | null;
}): SourceCommande {
  if (commande.auto === false) return 'telephone';
  if (commande.channel === OrderChannel.WEB) return 'site';
  return commande.auto === true ? 'appli' : 'telephone';
}

/**
 * Condition Prisma d'une source.
 *
 * ⚠️ Valeurs nulles : `channel: { not: 'WEB' }` s'écrit en SQL
 * `channel <> 'WEB'`, qui écarte les commandes sans canal (NULL). Toutes les
 * commandes de l'application antérieures au 02/10 le sont : d'où le `OR`
 * explicite avec `channel: null`.
 *
 * `auto` est obligatoire en base (`Boolean @default(true)`) : la règle
 * « `auto` vrai ou nul » du backoffice revient ici à `auto: true`.
 *
 * ⚠️ « appli » porte un `OR` : à ajouter dans un `AND`, jamais à étaler dans
 * un `where` qui a déjà le sien (le masquage des brouillons, par exemple).
 */
export function conditionSource(source: SourceCommande): Prisma.OrderWhereInput {
  switch (source) {
    case 'site':
      return { channel: OrderChannel.WEB, auto: true };
    case 'appli':
      return {
        auto: true,
        OR: [{ channel: null }, { channel: { not: OrderChannel.WEB } }],
      };
    case 'telephone':
      return { auto: false };
  }
}

/**
 * Conditions du filtre `source`, à ajouter au `AND` du `where`. Reprend le
 * masquage des brouillons du filtre historique `auto=true` : une commande
 * passée par le client (site ou application) encore EN ATTENTE est écartée,
 * sauf `avecBrouillons` (un rôle habilité qui demande lui-même le statut
 * « En attente », liste des commandes seulement). La saisie du personnel
 * garde tout, comme `auto=false`.
 *
 * Écrit dans le `AND`, il laisse en place le filtre `status` de l'appelant
 * (le filtre historique `auto=true` le remplace par « pas en attente »).
 */
export function conditionsFiltreSource(
  source: SourceCommande,
  options: { avecBrouillons: boolean },
): Prisma.OrderWhereInput[] {
  const conditions: Prisma.OrderWhereInput[] = [conditionSource(source)];
  if (source !== 'telephone' && !options.avecBrouillons) {
    conditions.push({ status: { not: OrderStatus.PENDING } });
  }
  return conditions;
}

/** Ajoute des conditions au `AND` d'un `where`, sans écraser l'existant. */
export function ajouterAuEt(
  where: Prisma.OrderWhereInput,
  conditions: Prisma.OrderWhereInput[],
): void {
  const existant = Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : [];
  where.AND = [...existant, ...conditions];
}
