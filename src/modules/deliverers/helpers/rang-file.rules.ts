import type { EtatAffichageLivreur } from './disponibilite.rules';

/**
 * PLACE DANS LA FILE D'UN LIVREUR, par restaurant (conception du 24/10, 11.5).
 *
 * La file est celle de la sélection des offres (`DelivererScoringService`) :
 * les livreurs du restaurant qui peuvent recevoir une offre (état
 * « Disponible » par la règle unique), du plus ancien en service au plus
 * récent (`last_available_at`). Le 1er de la file est celui qui reçoit la
 * prochaine offre à distance égale.
 *
 * Chaque restaurant a sa file : sur « Tous les restaurants », Awa d'Angré et
 * Moussa de Marcory peuvent être tous les deux « 1er de la file ».
 * L'ancien `queue_rank` de `GET /deliverers/live-locations`, lui, range tous
 * les livreurs lus ensemble (gardé pour les anciens écrans).
 *
 * Un livreur qui n'est pas « Disponible » (offre en attente, en course, en
 * pause, appli fermée, hors service) n'a pas de place : `null`.
 */
export interface LivreurDansLaFile {
  id: string;
  restaurant_id: string | null;
  etat: EtatAffichageLivreur;
  last_available_at: Date | string | null;
}

const temps = (v: Date | string | null): number => {
  if (!v) return Number.POSITIVE_INFINITY;
  const t = (v instanceof Date ? v : new Date(v)).getTime();
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
};

/** Place de chaque livreur « Disponible » dans la file de SON restaurant (1 = 1er). */
export function rangsDansLaFile(livreurs: readonly LivreurDansLaFile[]): Map<string, number> {
  const parRestaurant = new Map<string, LivreurDansLaFile[]>();
  for (const l of livreurs) {
    if (l.etat !== 'DISPONIBLE' || !l.restaurant_id) continue;
    const file = parRestaurant.get(l.restaurant_id) ?? [];
    file.push(l);
    parRestaurant.set(l.restaurant_id, file);
  }
  const rangs = new Map<string, number>();
  for (const file of parRestaurant.values()) {
    file
      .sort((a, b) => temps(a.last_available_at) - temps(b.last_available_at) || a.id.localeCompare(b.id))
      .forEach((l, i) => rangs.set(l.id, i + 1));
  }
  return rangs;
}
