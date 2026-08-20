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
 * Ce qu'est « un plat en promotion ».
 *
 * ⚠️ Cette clause RECOPIE volontairement la règle de facturation, celle qui
 * décide du prix réellement porté sur la commande :
 *
 *   `dish.is_promotion && dish.promotion_price !== null ? promotion_price : price`
 *   (`order/helpers/order.helper.ts` et `order/helpers/orderv2.helper.ts`)
 *
 * La vitrine doit montrer ce qui sera facturé comme promotion, ni plus ni
 * moins. Toute divergence produirait un plat annoncé en promotion et encaissé
 * plein tarif, ou l'inverse. Si la règle de facturation change un jour, celle-ci
 * change avec elle, et pas séparément.
 *
 * À savoir en la lisant : `promotion_price` vaut **0**, et non `null`, quand il
 * n'y a pas de promotion — c'est ce que le formulaire du backoffice enregistre.
 * Le `not: null` ne filtre donc presque rien en pratique ; c'est `is_promotion`
 * qui porte la décision. Un plat coché en promotion avec un prix réduit resté à
 * 0 apparaîtra ici, ce qui est cohérent avec la facturation et rend la saisie
 * fautive VISIBLE sur la page des promotions plutôt que silencieuse.
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
 * avait déjà déplacé à la main dans la vitrine y reste visible, même s'il n'est
 * plus en promotion. Aucune régression sur l'existant.
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
