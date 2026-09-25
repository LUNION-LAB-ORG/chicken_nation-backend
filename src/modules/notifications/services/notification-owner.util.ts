import { NotificationTarget } from '@prisma/client';

/**
 * Propriétaire d'une notification : le couple (user_id, target).
 * La cible USER désigne un User.id (personnel), la cible CUSTOMER un Customer.id (client).
 * Aucune clé étrangère ne relie ces colonnes : c'est ce couple, et lui seul, qui dit à qui
 * appartient une notification. Toute lecture ou écriture HTTP passe par lui.
 */
export interface NotificationOwner {
  user_id: string;
  target: NotificationTarget;
}

/** Plafond d'une page de la cloche. */
export const NOTIFICATIONS_PAGE_MAX = 100;

/** Taille de page quand l'appelant n'en demande pas. */
export const NOTIFICATIONS_PAGE_DEFAULT = 10;

/**
 * Numéro de page le plus haut accepté. Au-delà, le décalage (skip) déborde l'entier de la base
 * et Prisma lève une erreur 500 (page=100000000000000000000 passe ParseIntPipe). Aucune cloche
 * n'approche ce volume : une page plus lointaine répondrait de toute façon une liste vide.
 */
export const NOTIFICATIONS_PAGE_NUMBER_MAX = 100_000;

/**
 * Déduit le propriétaire à partir du principal authentifié (req.user).
 * Un membre du personnel est une ligne User, qui porte toujours un `role` ; un client est une
 * ligne Customer, qui n'en a pas. Même règle que getAuthType (messagerie/utils/getTypeUser.ts).
 * Renvoie null sans principal ou sans identifiant exploitable.
 */
export function notificationOwnerOf(principal: unknown): NotificationOwner | null {
  if (!principal || typeof principal !== 'object') return null;

  const id = (principal as { id?: unknown }).id;
  if (typeof id !== 'string' || id.length === 0) return null;

  return {
    user_id: id,
    target: 'role' in principal ? NotificationTarget.USER : NotificationTarget.CUSTOMER,
  };
}

/**
 * Vrai si le couple porté par le chemin (userId, target) est exactement celui du propriétaire.
 * Comparer l'identifiant seul ne suffit pas : la cible doit correspondre aussi.
 */
export function ownsNotifications(
  owner: NotificationOwner | null,
  userId: string,
  target: NotificationTarget,
): owner is NotificationOwner {
  return !!owner && owner.user_id === userId && owner.target === target;
}

/**
 * Pagination d'une cloche : page entière entre 1 et 100 000, taille entière entre 1 et 100.
 * Le plafond se pose par Math.min et SURTOUT PAS par un @Max : l'appli client demande
 * limit=1000 pour son rafraîchissement en direct (useRealtimeUpdates), un 400 le casserait.
 * Elle reçoit simplement les 100 plus récentes.
 */
export function normalizeNotificationPagination(
  page: unknown,
  limit: unknown,
): { page: number; limit: number; skip: number } {
  const pageNumber = Math.floor(Number(page));
  const limitNumber = Math.floor(Number(limit));

  const safePage =
    Number.isFinite(pageNumber) && pageNumber >= 1
      ? Math.min(pageNumber, NOTIFICATIONS_PAGE_NUMBER_MAX)
      : 1;
  const safeLimit =
    Number.isFinite(limitNumber) && limitNumber >= 1
      ? Math.min(limitNumber, NOTIFICATIONS_PAGE_MAX)
      : NOTIFICATIONS_PAGE_DEFAULT;

  return { page: safePage, limit: safeLimit, skip: (safePage - 1) * safeLimit };
}
