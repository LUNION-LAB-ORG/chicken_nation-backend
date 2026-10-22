/**
 * JOURNÉE DE SERVICE : de 05 h 00 à 05 h 00 le lendemain, heure d'Abidjan.
 *
 * Abidjan vit à l'heure UTC toute l'année (pas d'heure d'été) : le calcul se
 * fait en UTC, quel que soit le fuseau du serveur. Les restaurants ferment au
 * plus tard vers 1 h : une course créée à 0 h 40 appartient encore à la
 * journée de la veille, et plus rien n'est en cours à 5 h.
 *
 * Sert au code de retrait (incident du 22/10) : il est unique par restaurant
 * et par journée de service, et la caisse ne le cherche que parmi les courses
 * de la journée en cours.
 */
export const HEURE_DEBUT_JOURNEE_SERVICE = 5;

const UNE_JOURNEE_MS = 24 * 60 * 60 * 1000;

export interface JourneeDeService {
  /** Inclus : 05 h 00 du jour de service. */
  debut: Date;
  /** Exclu : 05 h 00 le lendemain. */
  fin: Date;
}

/** Journée de service qui contient `maintenant`. */
export function journeeDeService(maintenant: Date = new Date()): JourneeDeService {
  const debut = new Date(
    Date.UTC(
      maintenant.getUTCFullYear(),
      maintenant.getUTCMonth(),
      maintenant.getUTCDate(),
      HEURE_DEBUT_JOURNEE_SERVICE,
    ),
  );
  // Entre minuit et 5 h, on est encore dans la journée de la veille.
  if (maintenant.getTime() < debut.getTime()) {
    debut.setTime(debut.getTime() - UNE_JOURNEE_MS);
  }
  return { debut, fin: new Date(debut.getTime() + UNE_JOURNEE_MS) };
}
