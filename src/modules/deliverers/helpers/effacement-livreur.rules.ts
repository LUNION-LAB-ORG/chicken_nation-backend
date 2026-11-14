import { EntityStatus, Prisma } from '@prisma/client';

/**
 * Effacement d'un compte livreur au bout des 90 jours de grâce
 * (`DeliverersTask.purgeExpiredDeletions`).
 *
 * La ligne reste (les courses passées la référencent), mais tout ce qui
 * désigne la personne part : identité, coordonnées, pièces, numéros du permis
 * et du véhicule, adresse et position du domicile, dernière position connue,
 * jeton des notifications. La page publique de suppression du compte livreur
 * (`/fr/deletion-of-account` du site) et la fiche Google Play promettent cet
 * effacement : toute donnée personnelle ajoutée au livreur doit être ajoutée
 * ici (le test vérifie la liste).
 *
 * Restent : le type de véhicule, le restaurant de rattachement et les
 * courses, qui ne désignent plus personne une fois le reste effacé.
 */
export function donneesEffacementLivreur(id: string): Prisma.DelivererUpdateInput {
  return {
    entity_status: EntityStatus.DELETED,
    is_operational: false,
    refresh_token: null,
    // Libère le numéro d'origine (colonne obligatoire).
    phone: `deleted-${id}`,
    email: null,
    first_name: null,
    last_name: null,
    genre: null,
    image: null,
    piece_identite: null,
    permis_conduire: null,
    numero_permis: null,
    numero_immatriculation: null,
    home_location: Prisma.DbNull,
    home_address: null,
    last_location: Prisma.DbNull,
    last_location_at: null,
    last_speed_kmh: null,
    last_heading_deg: null,
    expo_push_token: null,
  };
}
