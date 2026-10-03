import { Prisma, PromotionStatus, Visibility } from '@prisma/client';

/**
 * PROMOTIONS AFFICHÉES AUX VISITEURS DU SITE : règles pures (03/10).
 *
 * La section « Offres du moment » de l'accueil lisait `GET /fidelity/promotions`,
 * réservée au personnel depuis le 15/01 : un visiteur recevait 401 et la
 * section ne s'affichait plus. La route publique ne renvoie que ce qu'un
 * visiteur peut voir :
 *  - promotions ACTIVES, PUBLIQUES (jamais celles réservées à un niveau) ;
 *  - commencées et pas encore expirées ;
 *  - seulement les champs de la carte : ni créateur, ni compteurs d'usage,
 *    ni ciblage.
 */

/** Nombre de promotions renvoyées par défaut, et au plus. */
export const LIMITE_PROMOTIONS_PUBLIQUES = 12;
export const LIMITE_MAX_PROMOTIONS_PUBLIQUES = 24;

/** Borne la limite demandée : entier entre 1 et 24, 12 sinon. */
export function limitePromotionsPubliques(demandee?: unknown): number {
  const n = Number(demandee);
  if (!Number.isFinite(n) || n < 1) return LIMITE_PROMOTIONS_PUBLIQUES;
  return Math.min(Math.floor(n), LIMITE_MAX_PROMOTIONS_PUBLIQUES);
}

/** Promotions visibles par un visiteur à l'instant donné. */
export function promotionsPubliquesWhere(maintenant: Date): Prisma.PromotionWhereInput {
  return {
    status: PromotionStatus.ACTIVE,
    visibility: Visibility.PUBLIC,
    start_date: { lte: maintenant },
    expiration_date: { gte: maintenant },
  };
}

/** Champs renvoyés au visiteur : ceux de la carte et de sa fenêtre de détail. */
export const CHAMPS_PROMOTION_PUBLIQUE = {
  id: true,
  title: true,
  description: true,
  discount_type: true,
  discount_value: true,
  min_order_amount: true,
  max_discount_amount: true,
  max_usage_per_user: true,
  start_date: true,
  expiration_date: true,
  status: true,
  coupon_image_url: true,
  background_color: true,
  text_color: true,
  expiration_color: true,
} satisfies Prisma.PromotionSelect;

export type PromotionPublique = Prisma.PromotionGetPayload<{
  select: typeof CHAMPS_PROMOTION_PUBLIQUE;
}>;
