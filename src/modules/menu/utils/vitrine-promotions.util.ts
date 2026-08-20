import { Prisma } from '@prisma/client';

/**
 * Vitrine des promotions.
 *
 * Jusqu'ici, mettre un plat en avant dans la catégorie « PROMOTIONS » voulait
 * dire l'y DÉPLACER : il quittait sa vraie catégorie, et le client qui ouvrait
 * « BURGERS » ne l'y trouvait plus. Une catégorie marquée `auto_promotions`
 * rassemble désormais d'elle-même les plats en promotion, où qu'ils soient.
 *
 * Rien n'est déplacé en base : `category_id` ne bouge pas, c'est la LECTURE qui
 * s'élargit. Le plat apparaît donc aux deux endroits, ce qui est exactement ce
 * qu'on veut.
 */

/**
 * Ce qu'est « un plat en promotion », et rien d'autre.
 *
 * Le prix remisé est exigé en plus du drapeau, parce que c'est la règle que
 * suit déjà tout le reste du serveur pour facturer : reçus, commandes et
 * statistiques ne retiennent `promotion_price` que s'il est renseigné
 * (`is_promotion && promotion_price != null`). Un plat coché en promotion mais
 * sans prix remisé est vendu plein tarif : l'afficher en vitrine afficherait
 * une étiquette « PROMO » sans remise, donc une promesse non tenue.
 */
export const PLAT_EN_PROMOTION: Prisma.DishWhereInput = {
  is_promotion: true,
  promotion_price: { not: null },
};

/**
 * Portée des plats d'une catégorie : la sienne, plus les promotions si elle est
 * une vitrine.
 *
 * La branche `category_id` est conservée dans les deux cas : un plat qu'on
 * avait déjà déplacé à la main dans la vitrine y reste visible, même s'il
 * n'est plus en promotion. Aucune régression sur l'existant.
 *
 * À combiner avec les autres filtres par `AND` et jamais en écrasant `OR`, que
 * la recherche par nom occupe déjà.
 */
export function porteeCategorie(
  categoryId: string,
  vitrine: boolean,
): Prisma.DishWhereInput {
  if (!vitrine) return { category_id: categoryId };
  return { OR: [{ category_id: categoryId }, PLAT_EN_PROMOTION] };
}
