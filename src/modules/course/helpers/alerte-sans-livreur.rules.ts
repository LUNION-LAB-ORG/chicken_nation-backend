/**
 * Seuil de l'alerte « Sans livreur », en minutes depuis la création de la
 * course. Une seule règle pour la cloche du serveur
 * (`CourseOfferService.retryUnassignedCourses`) et le tableau de la livraison
 * (`GET /livraison/tableau`), pour qu'ils disent la même chose au même moment.
 *
 * - Par défaut : `course.no_deliverer_alert_after_min`.
 * - Planificateur v2 avec Turbo actif : Turbo prend la course
 *   `course.turbo_fallback_after_min_v2` après la commande prête ; l'alerte
 *   attend une minute de plus pour lui laisser sa chance (sous v1, Turbo à
 *   4 min passait déjà avant l'alerte à 5 min).
 * - Course d'origine Turbo (toutes ses commandes confiées à Turbo) : le seuil
 *   par défaut, rien à attendre.
 */
export function seuilAlerteSansLivreurMin(p: {
  alerteMin: number;
  v2: boolean;
  turboActif: boolean;
  turboApresMinV2: number;
  turboNatif?: boolean;
}): number {
  if (p.turboNatif || !p.v2 || !p.turboActif) return p.alerteMin;
  return Math.max(p.alerteMin, p.turboApresMinV2 + 1);
}
