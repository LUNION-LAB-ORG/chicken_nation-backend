import { ForbiddenException } from '@nestjs/common';
import { User, UserType } from '@prisma/client';

/**
 * UUID impossible — utilisé comme sentinelle pour un user RESTAURANT qui
 * n'aurait (anormalement) aucun restaurant rattaché : on filtre alors sur cet
 * id inexistant → la requête ne renvoie AUCUNE commande, au lieu de fuiter
 * tout le réseau.
 */
const NO_RESTAURANT_SENTINEL = '00000000-0000-0000-0000-000000000000';

/**
 * Résout le restaurant effectivement visible par un utilisateur staff, à partir
 * de son JWT — JAMAIS d'un paramètre fourni par le client pour un user RESTAURANT.
 *
 *  - `UserType.RESTAURANT` (caissier, manager, assistant, cuisine d'un point de
 *    vente) : **forcé** à SON restaurant. Le `restaurantId` reçu en query est
 *    ignoré (un caissier ne peut pas demander un autre restaurant). Sans
 *    restaurant rattaché → sentinelle (aucun résultat).
 *  - `UserType.BACKOFFICE` (admin, call center, marketing, comptable…) : peut
 *    filtrer librement via le query param (onglet « par restaurant ») ou tout
 *    voir si aucun param (onglet « Tous les restaurants »).
 *
 * Renvoie l'id à injecter dans le `where` (ou `undefined` = tous les restaurants,
 * réservé au BACKOFFICE).
 */
export function resolveRestaurantScope(
  user: User | undefined,
  queryRestaurantId?: string,
): string | undefined {
  if (user?.type === UserType.RESTAURANT) {
    return user.restaurant_id ?? NO_RESTAURANT_SENTINEL;
  }
  // BACKOFFICE : filtre optionnel piloté par l'onglet côté UI.
  return queryRestaurantId || undefined;
}

/**
 * Vérifie qu'un user RESTAURANT n'accède pas à une ressource (commande, etc.)
 * appartenant à un autre restaurant. À appeler sur les endpoints « détail par
 * id » après chargement de la ressource. Sans effet pour le BACKOFFICE.
 */
export function assertCanAccessRestaurant(
  user: User | undefined,
  resourceRestaurantId: string | null | undefined,
): void {
  if (
    user?.type === UserType.RESTAURANT &&
    resourceRestaurantId !== user.restaurant_id
  ) {
    throw new ForbiddenException(
      "Accès refusé : cette ressource n'appartient pas à votre restaurant.",
    );
  }
}
