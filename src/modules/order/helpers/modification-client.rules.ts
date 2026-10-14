/**
 * Ce qu'un CLIENT peut modifier sur sa propre commande (PATCH /orders/:id/client).
 *
 * ⚠️ LISTE BLANCHE, pas liste noire. Le contrôleur retirait `status` et
 * `code_promo` puis laissait passer tout le reste dans `prisma.order.update` :
 * le DTO de modification hérite du DTO de création, donc un client pouvait
 * réécrire `restaurant_id`, `type`, `payment_method`, `delivery_service`,
 * `promotion_id` ou `points` de sa commande, sans contrôle d'activité,
 * d'ouverture, de plats ni de distance. Un identifiant de restaurant inconnu
 * faisait tomber la requête sur une clé étrangère. Relevé par la
 * contre-vérification de l'acheminement du 14/10.
 *
 * Une liste noire aurait laissé passer le prochain champ ajouté au DTO. Ici,
 * tout ce qui n'est pas nommé est ignoré, et on ne peut rien faire fuir sans
 * l'écrire ici, à côté de cet avertissement.
 *
 * Le seul usage réel dans l'application : « confirmer ma présence » et
 * repousser l'heure de retrait (`date`). Les coordonnées et la note sont du
 * même ordre : des champs qui n'engagent ni l'argent ni l'acheminement.
 */
export const CHAMPS_CLIENT_MODIFIABLES = [
  'date',
  'time',
  'address',
  'fullname',
  'phone',
  'email',
  'note',
  'table_type',
] as const;

export type ChampClientModifiable = (typeof CHAMPS_CLIENT_MODIFIABLES)[number];

/** Ne garde du corps reçu que les champs de la liste blanche, et seulement s'ils sont fournis. */
export function champsClientModifiables<T extends Record<string, unknown>>(
  corps: T,
): Partial<Pick<T, ChampClientModifiable & keyof T>> {
  const garde: Record<string, unknown> = {};
  for (const champ of CHAMPS_CLIENT_MODIFIABLES) {
    if (champ in corps && corps[champ] !== undefined) garde[champ] = corps[champ];
  }
  return garde as Partial<Pick<T, ChampClientModifiable & keyof T>>;
}
