/**
 * Événements INTERNES (bus EventEmitter2) de la diffusion des offres. Jamais
 * relayés tels quels aux sockets.
 */
export const DispatchEvenements = {
  /**
   * Une offre a été close alors que sa course cherche encore un livreur :
   * `DispatchListener` relance `offerNextDeliverer`. Charge : `{ course_id }`.
   * Passe par le bus pour que le service de clôture, fourni à tous les
   * modules, ne dépende pas de `CourseOfferService`.
   */
  RECHERCHE_A_RELANCER: 'dispatch.recherche.relancer',

  /**
   * Planificateur v2 : un passage est demandé pour un restaurant (commande
   * prête, livreur libre, offre refusée…). Les demandes sont regroupées par
   * restaurant (500 ms) par `CoursePlanificateurService`. Passe par le bus pour
   * que les services qui le demandent (offres, regroupement) ne dépendent pas
   * du planificateur, qui dépend d'eux. Charge : `DemandePlanification`.
   */
  PLANIFIER_RESTAURANT: 'dispatch.planificateur.restaurant',
} as const;

/** Charge de `DispatchEvenements.PLANIFIER_RESTAURANT`. */
export interface DemandePlanification {
  restaurant_id: string;
  /** Pourquoi (journal) : COMMANDE_PRETE, LIVREUR_DISPONIBLE, OFFRE_REFUSEE… */
  raison: string;
}
