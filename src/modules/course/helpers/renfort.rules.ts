import { DeliveryService } from '@prisma/client';
import { haversineMeters, ILatLng } from './geo.helper';

/**
 * RENFORT ENTRE RESTAURANTS (demande du 09/11).
 *
 * « Un livreur affecté à Faya livre une course près d'Angré : l'appli le
 * détecte à Angré et il peut livrer une commande d'Angré. »
 *
 * Un livreur garde son restaurant (planning, file, statistiques). Libre près
 * d'un autre restaurant, il en reçoit aussi les courses : le planificateur de
 * ce restaurant le compte parmi ses candidats et le classe comme les autres,
 * par son temps jusqu'au comptoir (règle « le plus rapide », choisie le
 * 09/11). Un livreur du restaurant déjà au comptoir passe donc d'abord.
 *
 * Son restaurant le sollicite toujours. Une seule offre à la fois par
 * livreur (verrou `CLASSE_VERROU_OFFRE_LIVREUR`) : deux restaurants ne
 * peuvent pas lui proposer deux courses en même temps.
 */

/** Réglages lus avec ceux du planificateur (`planification.rules.ts`). */
export const CLE_RENFORT = 'course.renfort';
export const CLE_RENFORT_RAYON_M = 'course.renfort_rayon_m';

/** Service de livraison par défaut et par restaurant (lus aussi par les frais de livraison). */
export const CLE_SERVICE_PAR_DEFAUT = 'delivery.default_service';
export const CLE_SERVICE_PAR_RESTAURANT = 'delivery.service_by_restaurant';

export interface RestaurantSitue {
  id: string;
  name?: string | null;
  position: ILatLng | null;
}

export interface RestaurantDeRenfort {
  id: string;
  name: string | null;
  distance_m: number;
}

/**
 * Restaurants où un livreur peut prêter main-forte, du plus proche au plus
 * loin : à `rayonM` au plus de lui, à vol d'oiseau, et STRICTEMENT plus près
 * de lui que son propre restaurant. Jamais le sien. Sans position, ou sans
 * restaurant à lui : aucun. Son restaurant sans coordonnées : la distance
 * seule décide.
 */
export function restaurantsDeRenfort(
  position: ILatLng | null,
  restaurantDuLivreur: string | null,
  restaurants: readonly RestaurantSitue[],
  rayonM: number,
): RestaurantDeRenfort[] {
  if (!position || !restaurantDuLivreur) return [];
  const sien = restaurants.find((r) => r.id === restaurantDuLivreur);
  const versLeSien = sien?.position ? haversineMeters(position, sien.position) : Number.POSITIVE_INFINITY;
  return restaurants
    .filter((r): r is RestaurantSitue & { position: ILatLng } => r.id !== restaurantDuLivreur && !!r.position)
    .map((r) => ({ id: r.id, name: r.name ?? null, distance_m: haversineMeters(position, r.position) }))
    .filter((r) => r.distance_m <= rayonM && r.distance_m < versLeSien)
    .sort((a, b) => a.distance_m - b.distance_m || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Le restaurant livre-t-il avec nos livreurs ? Réglage par restaurant
 * (`delivery.service_by_restaurant`, JSON { id: service }), sinon le défaut
 * (`delivery.default_service`, Turbo s'il est absent ou illisible) : même
 * lecture que les frais de livraison (`delivery-fee.helper.ts`). Sert à ne
 * montrer « En renfort près de … » que là où le renfort peut servir.
 */
export function livreParNosLivreurs(
  valeurs: Record<string, string | null | undefined>,
  restaurantId: string,
): boolean {
  const services = Object.values(DeliveryService) as string[];
  let parRestaurant: unknown = null;
  try {
    const brut = valeurs[CLE_SERVICE_PAR_RESTAURANT];
    parRestaurant = brut && brut.trim() ? JSON.parse(brut) : null;
  } catch {
    parRestaurant = null;
  }
  const propre =
    parRestaurant && typeof parRestaurant === 'object' ? (parRestaurant as Record<string, unknown>)[restaurantId] : undefined;
  if (typeof propre === 'string' && services.includes(propre)) return propre === DeliveryService.CHICKEN_NATION;
  const defaut = valeurs[CLE_SERVICE_PAR_DEFAUT]?.trim();
  return defaut === DeliveryService.CHICKEN_NATION;
}
