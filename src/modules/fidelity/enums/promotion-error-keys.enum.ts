export enum PromotionErrorKeys {
    // Erreurs de validation des restaurants
    /**
     * Indique qu'aucun restaurant n'a été sélectionné pour la promotion.
     */
    PROMOTION_MISSING_RESTAURANTS = 'PROMOTION_MISSING_RESTAURANTS',
    // Erreurs de validation des dates
    /**
     * Indique que la plage de dates spécifiée pour la promotion est invalide.
     * Généralement, la date de début est égale ou postérieure à la date de fin.
     */
    PROMOTION_INVALID_DATE_RANGE = 'PROMOTION_INVALID_DATE_RANGE',

    // Erreurs de validation du ciblage
    /**
     * Indique qu'aucun plat ciblé n'a été spécifié pour une promotion nécessitant des plats ciblés.
     * Applicable lorsque `target_type` est `SPECIFIC_PRODUCTS`.
     */
    PROMOTION_MISSING_TARGETED_DISHES = 'PROMOTION_MISSING_TARGETED_DISHES',
    
    /**
     * Indique qu'aucune catégorie ciblée n'a été spécifiée pour une promotion nécessitant des catégories ciblées.
     * Applicable lorsque `target_type` est `CATEGORIES`.
     */
    PROMOTION_MISSING_TARGETED_CATEGORIES = 'PROMOTION_MISSING_TARGETED_CATEGORIES',

    // Erreurs de visibilité
    /**
     * Indique qu'aucun niveau de fidélité n'a été sélectionné pour une promotion privée.
     * Applicable lorsque `visibility` est `PRIVATE`.
     */
    PROMOTION_MISSING_LOYALTY_LEVELS = 'PROMOTION_MISSING_LOYALTY_LEVELS',

    // Erreurs de type de remise
    /**
     * Indique qu'aucun plat offert n'a été spécifié pour une promotion de type "Achetez X, obtenez Y".
     * Applicable lorsque `discount_type` est `BUY_X_GET_Y`.
     */
    PROMOTION_MISSING_OFFERED_DISHES = 'PROMOTION_MISSING_OFFERED_DISHES',
    /**
     * Indique que le pourcentage de remise spécifié dépasse la limite autorisée (par exemple, 70%).
     * Applicable lorsque `discount_type` est `PERCENTAGE`.
     */
    PROMOTION_DISCOUNT_PERCENTAGE_TOO_HIGH = 'PROMOTION_DISCOUNT_PERCENTAGE_TOO_HIGH',
    /**
     * Indique que le montant minimum de commande requis n'a pas été spécifié pour une remise de montant fixe.
     * Applicable lorsque `discount_type` est `FIXED_AMOUNT`.
     */
    PROMOTION_MISSING_MIN_ORDER_AMOUNT = 'PROMOTION_MISSING_MIN_ORDER_AMOUNT',

    // Erreurs d'utilisation
    /**
     * Indique que la promotion recherchée n'existe pas ou est introuvable.
     */
    PROMOTION_NOT_FOUND = 'PROMOTION_NOT_FOUND',
    /**
     * Indique que la limite d'utilisation maximale pour la promotion a été atteinte.
     */
    PROMOTION_USAGE_LIMIT_REACHED = 'PROMOTION_USAGE_LIMIT_REACHED',
    /**
     * Indique que la promotion est épuisée (par exemple, toutes les utilisations disponibles ont été consommées).
     */
    PROMOTION_EXHAUSTED = 'PROMOTION_EXHAUSTED',
    /**
     * Indique que l'utilisateur ou le client n'a pas les permissions ou le niveau de fidélité requis
     * pour accéder à cette promotion.
     */
    PROMOTION_NOT_ACCESSIBLE = 'PROMOTION_NOT_ACCESSIBLE',
    /**
     * Indique que le client associé à la tentative d'utilisation de la promotion n'a pas été trouvé.
     */
    PROMOTION_CUSTOMER_NOT_FOUND = 'PROMOTION_CUSTOMER_NOT_FOUND',
    /**
     * Indique que la promotion ne peut pas être appliquée à la commande ou au contexte actuel.
     * Peut couvrir diverses raisons non spécifiques.
     */
    PROMOTION_NOT_APPLICABLE = 'PROMOTION_NOT_APPLICABLE',
    /**
     * Indique que la promotion est inactive ou a expiré et ne peut plus être utilisée.
     */
    PROMOTION_INACTIVE_OR_EXPIRED = 'PROMOTION_INACTIVE_OR_EXPIRED',
    /**
     * Indique que le montant total de la commande est inférieur au montant minimum requis pour appliquer la promotion.
     */
    PROMOTION_MIN_ORDER_AMOUNT_NOT_REACHED = 'PROMOTION_MIN_ORDER_AMOUNT_NOT_REACHED',
    /**
     * Indique que la commande ne contient aucun plat, rendant l'application de la promotion impossible.
     */
    PROMOTION_NO_ITEMS_IN_ORDER = 'PROMOTION_NO_ITEMS_IN_ORDER',
    /**
     * Indique que le nombre d'articles éligibles dans la commande est insuffisant
     * pour une promotion de type "Achetez X, obtenez Y".
     */
    PROMOTION_INSUFFICIENT_ITEMS_FOR_BUY_X_GET_Y = 'PROMOTION_INSUFFICIENT_ITEMS_FOR_BUY_X_GET_Y'
}