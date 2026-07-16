import { Customer, DishAudience, LoyaltyLevel, Prisma, ProfileType } from '@prisma/client';

/**
 * Contexte d'audience résolu pour UNE requête de lecture de plats/catégories.
 *
 *  - `apply: false` → AUCUN filtre (staff en gestion des menus, ou appel interne).
 *  - `apply: true` + `customer` → filtre par CE client (client app connecté, ou
 *    client cible d'une prise de commande backoffice).
 *  - `apply: true` sans `customer` → invité : plats PUBLIC uniquement.
 *
 * Voir {@link DishService.resolveAudience} pour la résolution depuis la requête.
 */
export type AudienceContext = { apply: boolean; customer?: Customer };

/**
 * Ciblage d'audience des plats.
 *
 * Un plat porte `audiences: DishAudience[]` :
 *  - `[]`  → PUBLIC (visible par tout le monde, y compris invité) ;
 *  - sinon → visible UNIQUEMENT par les clients dont l'audience recoupe la liste.
 *
 * L'audience d'un CLIENT = { ETUDIANT si profil étudiant } ∪ { son niveau de
 * fidélité EXACT }. Match STRICT (pas cumulatif) : un plat `[VIP]` n'est PAS vu
 * par un VVIP tant que `VVIP` n'est pas coché aussi. Un invité (pas de client)
 * n'a aucune audience → ne voit que les plats PUBLIC.
 */

type AudienceCustomer = {
  profile_type?: ProfileType | null;
  loyalty_level?: LoyaltyLevel | null;
} | null | undefined;

const LEVEL_TO_AUDIENCE: Record<LoyaltyLevel, DishAudience> = {
  [LoyaltyLevel.STANDARD]: DishAudience.STANDARD,
  [LoyaltyLevel.VIP]: DishAudience.VIP,
  [LoyaltyLevel.VVIP]: DishAudience.VVIP,
};

/** Ensemble des audiences que ce client peut voir (hors PUBLIC, géré à part). */
export function customerAudiences(customer: AudienceCustomer): DishAudience[] {
  if (!customer) return [];
  const set: DishAudience[] = [];
  if (customer.profile_type === ProfileType.ETUDIANT) {
    set.push(DishAudience.ETUDIANT);
  }
  // Niveau null (jamais calculé) traité comme STANDARD par défaut.
  const level = customer.loyalty_level ?? LoyaltyLevel.STANDARD;
  set.push(LEVEL_TO_AUDIENCE[level]);
  return set;
}

/**
 * Clause Prisma à combiner (via AND) dans le `where` des listes de plats côté
 * app. À placer dans un tableau `AND: [dishAudienceClause(customer)]` pour ne
 * jamais entrer en conflit avec un éventuel `OR` de recherche déjà présent.
 */
export function dishAudienceClause(customer: AudienceCustomer): Prisma.DishWhereInput {
  const mine = customerAudiences(customer);
  if (mine.length === 0) {
    // Invité → uniquement les plats publics (audiences vide).
    return { audiences: { isEmpty: true } };
  }
  return {
    OR: [
      { audiences: { isEmpty: true } }, // PUBLIC
      { audiences: { hasSome: mine } }, // partage au moins une audience
    ],
  };
}
