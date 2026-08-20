import { Prisma } from '@prisma/client';

/**
 * Vitrine des promotions.
 *
 * Jusqu'ici, mettre un plat en avant dans la catégorie « PROMOTIONS » voulait
 * dire l'y DÉPLACER : il quittait sa vraie catégorie, et le client qui ouvrait
 * « LES BURGERS » ne l'y trouvait plus. Une catégorie marquée `auto_promotions`
 * rassemble désormais d'elle-même les plats en promotion, où qu'ils soient.
 *
 * Rien n'est déplacé en base : `category_id` ne bouge pas, c'est la LECTURE qui
 * s'élargit. Le plat apparaît donc aux deux endroits, ce qui est exactement ce
 * qu'on veut.
 */

/**
 * Ce qu'est « un plat en promotion » : le PRIX et le PRIX RÉDUIT en décident,
 * pas le drapeau `is_promotion`.
 *
 * ⚠️ Deux bornes, et les deux sont nécessaires.
 *
 * `> 0` d'abord. Un plat sans promotion ne porte pas un prix réduit ABSENT, il
 * le porte à **0** : c'est ce que le formulaire du backoffice enregistre. Sur la
 * carte du 20/08, 12 plats sur 18 étaient dans ce cas. Se contenter de
 * « prix réduit inférieur au prix » aurait donc mis la carte ENTIÈRE en
 * vitrine, puisque 0 est inférieur à tout. La comparaison exclut aussi `null`
 * d'elle-même : en SQL, `NULL > 0` ne vaut pas vrai.
 *
 * `< prix` ensuite, sinon une saisie où le prix réduit dépasse le prix afficherait
 * en promotion un plat devenu plus cher.
 *
 * La comparaison entre deux colonnes passe par une référence de champ Prisma,
 * d'où le paramètre : elle se lit sur le client (`prisma.dish.fields.price`) et
 * ne peut pas être écrite en constante.
 */
export function platEnPromotion(
  refPrix: Prisma.FloatFieldRefInput<'Dish'>,
): Prisma.DishWhereInput {
  return { promotion_price: { gt: 0, lt: refPrix } };
}

/**
 * Portée des plats d'une catégorie : la sienne, plus les promotions si elle est
 * une vitrine.
 *
 * La branche `category_id` est conservée dans les deux cas : un plat qu'on
 * avait déjà déplacé à la main dans la vitrine y reste visible, même s'il n'est
 * plus en promotion. Aucune régression sur l'existant.
 *
 * À combiner avec les autres filtres par `AND` et jamais en écrasant `OR`, que
 * la recherche par nom occupe déjà.
 */
export function porteeCategorie(
  categoryId: string,
  vitrine: boolean,
  refPrix: Prisma.FloatFieldRefInput<'Dish'>,
): Prisma.DishWhereInput {
  if (!vitrine) return { category_id: categoryId };
  return { OR: [{ category_id: categoryId }, platEnPromotion(refPrix)] };
}
