/**
 * Décisions des contrôles de livraison, isolées du service.
 *
 * Elles vivent ici, en fonctions pures, pour une raison précise : ce sont des
 * SEUILS, et un seuil se règle. Chacun a été calibré sur les données réelles de
 * production, et devra l'être à nouveau le jour où un sixième restaurant ouvre
 * ou où la grille change. Les enfouir au milieu d'un service de 3 000 lignes les
 * rendrait introuvables et intestables ; ici, ils se lisent d'un coup d'œil et
 * les tests disent ce qu'on a voulu.
 *
 * Aucune de ces fonctions ne touche la base, le réseau ou l'horloge.
 */

/** Tolérance d'arrondi, en francs. Les montants réels sont des multiples de 500. */
export const TOLERANCE_FCFA = 1;

/**
 * Écart de distance, en kilomètres, au-delà duquel un rattachement interpelle.
 *
 * Calibré sur 30 jours : 30 rattachements discutables, dont 15 sous le
 * kilomètre — du bruit géométrique — et 11 au-delà de 3 km. À ce seuil, environ
 * 0,4 message par jour.
 */
export const SEUIL_ECART_ACHEMINEMENT_KM = 3;

/**
 * Distance, par la route, au-delà de laquelle une course interpelle.
 *
 * Demandé à 15 km. Mesuré : 14 commandes sur 9 jours, soit 1,6 par jour.
 * ⚠️ À poser sur la distance ROUTIÈRE. Sur le vol d'oiseau, le même seuil ne
 *    voit que 2 dépassements là où la route en voit 10.
 */
export const SEUIL_LOIN_KM = 15;

export type MotifTarif = 'surfacture' | 'sous-facture' | null;

/**
 * L'écart entre le facturé et le calculé est-il EXPLIQUÉ par la remise ?
 *
 * On ne compare pas le facturé à la grille : les zones Turbo fixent le prix de
 * trois commandes sur quatre, et rejouer la grille produirait des centaines de
 * faux écarts. On ne retient pas non plus un seuil en francs : sur neuf jours,
 * 123 écarts sur 135 sont des remises parfaitement enregistrées, donc des gestes
 * commerciaux normaux, et les alerter serait du bruit.
 *
 * La seule question qui vaille est : `facturé + remise` se recolle-t-il à la
 * base ? Quand non, de l'argent a bougé sans que rien ne l'explique. C'est le
 * seul moyen de voir une SURFACTURATION, que le calcul de la remise —
 * `Math.max(0, base - facturé)` — écrase à zéro.
 */
export function ecartTarifInexplique(
  facture: number,
  base: number,
  remise: number,
): { motif: MotifTarif; montant: number } {
  // Sans base calculée, il n'y a rien à quoi comparer : une commande créée
  // avant que la base existe, ou un enlèvement, ne sont pas des anomalies.
  if (!(base > 0)) return { motif: null, montant: 0 };

  const ecart = facture + remise - base;
  if (Math.abs(ecart) <= TOLERANCE_FCFA) return { motif: null, montant: 0 };

  return {
    motif: ecart > 0 ? 'surfacture' : 'sous-facture',
    montant: Math.round(Math.abs(ecart)),
  };
}

/**
 * Un point de livraison est-il exploitable ?
 *
 * (0,0) est au large du golfe de Guinée : c'est la signature d'un point
 * manquant, pas d'une adresse. Comparer des distances à ce point ferait crier
 * sur chaque commande.
 */
export function pointExploitable(
  lat: number | null | undefined,
  lon: number | null | undefined,
): boolean {
  if (typeof lat !== 'number' || typeof lon !== 'number') return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (lat === 0 && lon === 0) return false;
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

/**
 * Le restaurant retenu est-il nettement plus loin que le meilleur candidat ?
 *
 * ⚠️ Comparaison à VOL D'OISEAU alors que la facturation se fait par la route.
 *    Assumé : chercher le plus proche par la route coûterait cinq appels Google
 *    par commande, sur le chemin de création, pour départager des candidats que
 *    le vol d'oiseau sépare déjà largement au seuil retenu.
 */
export function acheminementInterpelle(
  kmRetenu: number | null,
  kmMeilleur: number | null,
): boolean {
  if (kmRetenu == null || kmMeilleur == null) return false;
  return kmRetenu - kmMeilleur >= SEUIL_ECART_ACHEMINEMENT_KM;
}

/** La course est-elle exceptionnellement longue ? */
export function courseTresLongue(distanceKm: number | null | undefined): boolean {
  return typeof distanceKm === 'number' && distanceKm >= SEUIL_LOIN_KM;
}
