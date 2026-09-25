import { Prisma } from '@prisma/client';

/**
 * Colonnes SECRÈTES d'un restaurant : la clé API Turbo et les accès HubRise.
 *
 * Elles ne servent qu'aux appels sortants (Turbo, HubRise) et au contrôle de
 * clé des webhooks Turbo, qui les lisent chacun par une requête dédiée. Elles
 * ne doivent jamais partir dans une réponse HTTP ni sur un socket.
 *
 * Revue 25/09 : un `include: { restaurant: true }` sur les commandes et le
 * personnel renvoyait la ligne complète. Un client récupérait la clé Turbo en
 * créant ou en annulant sa commande, et chaque commande la diffusait dans
 * `backoffice_all` et `restaurant_{id}`, salle écoutée aussi par les livreurs.
 */
export const CHAMPS_SECRETS_RESTAURANT = [
  'apikey',
  'hubrise_access_token',
  'hubrise_location_id',
  'hubrise_catalog_id',
  'hubrise_customer_list_id',
] as const;

/**
 * Restaurant joint à une COMMANDE, dans les réponses HTTP comme dans les
 * événements socket. Même liste que GET /orders/:id, qui couvre tout ce que
 * lisent les écrans : ticket imprimé du backoffice et de la caisse (nom,
 * adresse, téléphone, courriel), suivi de livraison de l'application
 * (latitude, longitude) et cloche du personnel (nom).
 */
export const RESTAURANT_COMMANDE_SELECT = {
  id: true,
  name: true,
  image: true,
  address: true,
  phone: true,
  email: true,
  latitude: true,
  longitude: true,
} as const satisfies Prisma.RestaurantSelect;

export type RestaurantCommande = Prisma.RestaurantGetPayload<{
  select: typeof RESTAURANT_COMMANDE_SELECT;
}>;

/**
 * Restaurant joint à un MEMBRE DU PERSONNEL (liste, profil, création,
 * édition). `manager` alimente le drapeau « manager principal » de la page
 * Personnel du backoffice.
 */
export const RESTAURANT_PERSONNEL_SELECT = {
  id: true,
  name: true,
  manager: true,
} as const satisfies Prisma.RestaurantSelect;

export type UtilisateurAvecRestaurant = Prisma.UserGetPayload<{
  include: { restaurant: { select: typeof RESTAURANT_PERSONNEL_SELECT } };
}>;
