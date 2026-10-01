import { EntityStatus } from '@prisma/client';
import { DelivererChannels } from 'src/modules/deliverers/enums/deliverer-channels';
import { peutVoirLesBrouillons } from 'src/modules/order/helpers/brouillons.rules';
import { ConnectedUser } from '../interfaces/app.gateway.interface';

/**
 * Salles de la passerelle `/app` : qui entend quoi.
 *
 * Une salle est une liste de diffusion. Tout ce qu'on y émet part à chacun de
 * ses membres, qu'il en ait l'usage ou non : la seule protection réelle est de
 * n'y faire entrer que ceux à qui ses événements sont destinés.
 *
 *  - `customer_{id}`, `user_{id}`, `deliverer_{id}` : canal privé d'une personne.
 *  - `customers` : toutes les apps clientes. N'y part que ce qui ne concerne
 *    personne en particulier (menu:updated, promo:updated).
 *  - `users` : tout le personnel, quel que soit son rôle.
 *  - `backoffice_all` : tout compte BACKOFFICE.
 *  - `restaurant_{id}` : le personnel du point de vente (caisse, cuisine,
 *    gérant). Commandes, courses, tickets et messages des clients y circulent.
 *  - `livreurs_restaurant_{id}` : les livreurs rattachés au restaurant. Ils n'y
 *    reçoivent que les événements de `EVENEMENTS_RESTAURANT_POUR_LIVREURS`.
 *  - `relances_paniers` : rôles qui suivent les paniers non payés de
 *    l'application (ADMIN, CALL_CENTER), quel que soit le type du compte. N'y
 *    part que `relance:changed`, sans donnée personnelle.
 *
 * Les livreurs rejoignaient autrefois `restaurant_{id}`. Chacun recevait ainsi
 * les commandes et les courses de tout le restaurant (nom, téléphone, adresse et
 * point GPS des clients), les tickets et les conversations des clients, la
 * position de ses collègues à chaque relevé GPS et leur fiche complète. Leur
 * propre activité (offres, courses, statut, pause) leur arrive déjà par
 * `deliverer_{id}` : du restaurant, ils n'ont besoin que de la file d'attente.
 * Leurs propres tickets ne sont liés à aucune commande : ils ne passaient
 * jamais par la salle du restaurant.
 *
 * Il n'y a plus de salle commune à tous les sockets : la salle `restaurants`,
 * rejointe par les clients comme par le personnel, ne recevait rien, et le
 * premier événement qui y serait parti aurait atteint tous les clients. La
 * salle `deliverers` (tous les livreurs) disparaît pour la même raison.
 */

export const SALLE_CLIENTS = 'customers';
export const SALLE_PERSONNEL = 'users';
export const SALLE_BACKOFFICE = 'backoffice_all';
/**
 * Relance des paniers non payés. Règle sur le RÔLE seul (`peutVoirLesBrouillons`).
 * Limite connue : le rôle est lu à la connexion (cache de 10 s, aucun suivi des
 * changements de rôle), un compte rétrogradé reste dans la salle jusqu'à sa
 * reconnexion. L'événement ne dit que « il y a du nouveau », la liste reste
 * gardée par rôle.
 */
export const SALLE_RELANCES = 'relances_paniers';

const PREFIXE_LIVREURS_RESTAURANT = 'livreurs_restaurant_';

export const salleClient = (customerId: string) => `customer_${customerId}`;
export const salleUtilisateur = (userId: string) => `user_${userId}`;
export const salleLivreur = (delivererId: string) => `deliverer_${delivererId}`;
export const salleRestaurant = (restaurantId: string) => `restaurant_${restaurantId}`;
export const salleLivreursRestaurant = (restaurantId: string) =>
  `${PREFIXE_LIVREURS_RESTAURANT}${restaurantId}`;

/** Canal privé d'une personne, selon le type de son jeton. */
export function sallePersonnelle(type: ConnectedUser['type'], id: string): string {
  switch (type) {
    case 'customer':
      return salleClient(id);
    case 'user':
      return salleUtilisateur(id);
    case 'deliverer':
      return salleLivreur(id);
  }
}

/**
 * Événements émis vers un restaurant que ses livreurs doivent aussi recevoir.
 *
 * Liste fermée : tout événement absent reste entre les membres du personnel.
 * `deliverer:queue:changed` ne porte que l'identifiant du livreur dont l'état
 * a changé ; chaque livreur s'en sert pour recalculer son rang dans la file.
 */
export const EVENEMENTS_RESTAURANT_POUR_LIVREURS: ReadonlySet<string> = new Set<string>([
  DelivererChannels.DELIVERER_QUEUE_CHANGED,
]);

export function estRelayeAuxLivreurs(evenement: string): boolean {
  return EVENEMENTS_RESTAURANT_POUR_LIVREURS.has(evenement);
}

/**
 * Salles qui reçoivent un événement émis « vers un restaurant » : son
 * personnel toujours, ses livreurs seulement pour les événements de la liste.
 */
export function sallesDiffusionRestaurant(restaurantId: string, evenement: string): string[] {
  const salles = [salleRestaurant(restaurantId)];
  if (estRelayeAuxLivreurs(evenement)) {
    salles.push(salleLivreursRestaurant(restaurantId));
  }
  return salles;
}

/** Salles rejointes à la connexion, selon qui se connecte. */
export function sallesAJoindre(
  connexion: Pick<ConnectedUser, 'id' | 'type' | 'userType' | 'restaurantId' | 'role'>,
): string[] {
  switch (connexion.type) {
    case 'customer':
      return [SALLE_CLIENTS, salleClient(connexion.id)];

    case 'user': {
      const salles = [SALLE_PERSONNEL, salleUtilisateur(connexion.id)];
      if (connexion.userType === 'BACKOFFICE') {
        // Le backoffice voit tous les restaurants
        salles.push(SALLE_BACKOFFICE);
      } else if (connexion.userType === 'RESTAURANT' && connexion.restaurantId) {
        // Le personnel d'un point de vente ne voit que le sien
        salles.push(salleRestaurant(connexion.restaurantId));
      }
      if (peutVoirLesBrouillons({ role: connexion.role })) {
        salles.push(SALLE_RELANCES);
      }
      return salles;
    }

    case 'deliverer': {
      const salles = [salleLivreur(connexion.id)];
      if (connexion.restaurantId) {
        salles.push(salleLivreursRestaurant(connexion.restaurantId));
      }
      return salles;
    }

    default:
      return [];
  }
}

/**
 * Restaurant dont un livreur doit suivre la file d'après sa fiche, ou `null`.
 * Même règle qu'à la connexion : un compte qui n'est plus actif (supprimé) n'est
 * plus reconnu, et un livreur sans restaurant n'a pas de file à suivre.
 */
export function restaurantSuiviParLivreur(livreur: {
  restaurant_id?: string | null;
  entity_status?: string | null;
}): string | null {
  if (livreur.entity_status !== EntityStatus.ACTIVE || !livreur.restaurant_id) {
    return null;
  }
  return livreur.restaurant_id;
}

/**
 * Salles de livreurs à quitter pour ne garder que `cible` (toutes si `null`).
 * Les autres salles du socket, dont son canal privé, ne sont pas touchées.
 */
export function sallesLivreursARetirer(
  salles: Iterable<string>,
  cible: string | null,
): string[] {
  const aRetirer: string[] = [];
  for (const salle of salles) {
    if (salle.startsWith(PREFIXE_LIVREURS_RESTAURANT) && salle !== cible) {
      aRetirer.push(salle);
    }
  }
  return aRetirer;
}
