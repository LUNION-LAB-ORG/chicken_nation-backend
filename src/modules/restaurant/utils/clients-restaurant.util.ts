import { EntityStatus, Prisma } from '@prisma/client';

/**
 * GET /restaurants/:id/clients : choix d'un client dans les fenêtres
 * « Nouvelle conversation » et « Nouveau ticket » du backoffice.
 *
 * La route renvoyait à chaque frappe TOUS les clients ayant commandé dans le
 * restaurant, fiche complète (date de naissance, points, niveau, code de
 * parrainage, consentement WhatsApp, dernière connexion), comptes supprimés
 * compris, et ignorait la recherche. Elle ne renvoie plus que de quoi
 * reconnaître le client dans la liste, une page à la fois, filtrée par la base.
 */

/** Taille de page par défaut, et plafond. */
export const CLIENTS_RESTAURANT_LIMITE_DEFAUT = 50;
export const CLIENTS_RESTAURANT_LIMITE_MAX = 100;

/** Au-delà, les mots de la recherche sont ignorés (requête bornée). */
const MOTS_RECHERCHE_MAX = 5;
const LONGUEUR_RECHERCHE_MAX = 100;

/** Exactement ce qu'affiche la liste déroulante : nom, e-mail, téléphone, photo. */
export const CLIENT_DE_RESTAURANT_SELECT = {
  id: true,
  first_name: true,
  last_name: true,
  email: true,
  phone: true,
  image: true,
} as const satisfies Prisma.CustomerSelect;

/** Page et taille demandées (chaînes d'URL), converties et bornées. */
export function paginationClientsRestaurant(
  page?: unknown,
  limit?: unknown,
): { page: number; limit: number; skip: number } {
  const p = Math.floor(Number(page));
  const l = Math.floor(Number(limit));
  const pageSure = Number.isFinite(p) && p >= 1 ? p : 1;
  const limitSure =
    Number.isFinite(l) && l >= 1
      ? Math.min(l, CLIENTS_RESTAURANT_LIMITE_MAX)
      : CLIENTS_RESTAURANT_LIMITE_DEFAUT;
  return { page: pageSure, limit: limitSure, skip: (pageSure - 1) * limitSure };
}

/** Mots de la recherche, sans espaces superflus, bornés en nombre et en taille. */
export function motsDeRecherche(search?: unknown): string[] {
  if (typeof search !== 'string') return [];
  return search
    .slice(0, LONGUEUR_RECHERCHE_MAX)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MOTS_RECHERCHE_MAX);
}

/**
 * Filtre des clients d'un restaurant : actifs, ayant au moins une commande
 * dans CE restaurant, et, si une recherche est saisie, dont chaque mot se
 * retrouve dans le prénom, le nom, l'e-mail ou le téléphone. « Awa Koné »
 * trouve donc la cliente dont le prénom est Awa et le nom Koné.
 *
 * Pour le téléphone, seuls les chiffres du mot comptent : « 07-08-09 »
 * cherche 070809, « +2250708 » cherche 2250708.
 */
export function filtreClientsRestaurant(
  restaurantId: string,
  search?: unknown,
): Prisma.CustomerWhereInput {
  const where: Prisma.CustomerWhereInput = {
    entity_status: EntityStatus.ACTIVE,
    orders: { some: { restaurant_id: restaurantId } },
  };

  const mots = motsDeRecherche(search);
  if (mots.length === 0) return where;

  where.AND = mots.map((mot) => {
    const chiffres = mot.replace(/\D/g, '');
    const ou: Prisma.CustomerWhereInput[] = [
      { first_name: { contains: mot, mode: 'insensitive' } },
      { last_name: { contains: mot, mode: 'insensitive' } },
      { email: { contains: mot, mode: 'insensitive' } },
    ];
    if (chiffres) ou.push({ phone: { contains: chiffres } });
    return { OR: ou };
  });

  return where;
}
