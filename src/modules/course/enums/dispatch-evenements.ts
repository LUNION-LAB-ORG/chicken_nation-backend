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
} as const;
