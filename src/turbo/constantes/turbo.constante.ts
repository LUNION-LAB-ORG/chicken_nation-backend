import { PaiementMode } from "@prisma/client";

export const TURBO_API = {
    CREATION_COURSE: 'https://backend-prod.turbodeliveryapp.com/api/restaurant/course-externe/commande',
    FRAIS_LIVRAISON: 'https://backend-prod.turbodeliveryapp.com/api/restaurant/course-externe/recupererLesFraisDuRestaurant',
    LISTE_FRAIS: 'https://backend-prod.turbodeliveryapp.com/api/erp/frais-livraison/restaurant/listeFrais?page=0&size=10',
}

export const TURBO_API_KEY = 'jq3JVrMe10Isbdo2PR0OvdFUKRIFI61S';


export const mappingMethodPayment = {
    [PaiementMode.MOBILE_MONEY]: PaiementMode.MOBILE_MONEY,
    [PaiementMode.WALLET]: PaiementMode.WALLET,
    [PaiementMode.CARD]: PaiementMode.CARD,
    [PaiementMode.CASH]: PaiementMode.CASH,
}

/**
 * Calcule le prix de livraison basé sur la distance (Modèle Abidjan/Yango)
 * @param {number} distanceInKm - La distance exacte (ex: 5.4)
 * @returns {number} - Le prix final arrondi en FCFA
 */
export const calculateDeliveryPrice = (distanceInKm) => {
    // --- CONFIGURATION DES TARIFS (Augmentés) ---

    // 1. Le Forfait de base (jusqu'à 3 km)
    // Cela couvre la prise en charge et le "dérangement" du livreur
    const BASE_DIST_KM = 3;
    const BASE_PRICE = 1000;

    // 2. Le prix au Km en Zone Urbaine (de 3km à 10km)
    // C'est plus cher car plus de trafic/feux tricolores
    const PRICE_PER_KM_URBAN = 250;

    // 3. Le prix au Km Longue Distance (au-delà de 10km)
    // Un peu moins cher au km car la moto roule mieux (voies rapides)
    const PRICE_PER_KM_LONG = 200;

    let finalPrice = 0;

    // --- LOGIQUE DE CALCUL ---

    if (distanceInKm <= BASE_DIST_KM) {
        // Cas 1 : Très courte distance
        finalPrice = BASE_PRICE;
    }
    else if (distanceInKm <= 10) {
        // Cas 2 : Distance Moyenne (3km - 10km)
        const extraKm = distanceInKm - BASE_DIST_KM;
        finalPrice = BASE_PRICE + (extraKm * PRICE_PER_KM_URBAN);
    }
    else {
        // Cas 3 : Longue distance (> 10km)
        // On calcule d'abord le prix complet des 10 premiers km
        const priceForFirst10Km = BASE_PRICE + ((10 - BASE_DIST_KM) * PRICE_PER_KM_URBAN);

        // Puis on ajoute le reste avec le tarif "route"
        const extraKm = distanceInKm - 10;
        finalPrice = priceForFirst10Km + (extraKm * PRICE_PER_KM_LONG);
    }

    // --- ARRONDISSEMENT "SPÉCIAL ABIDJAN" ---
    // On arrondit toujours à la centaine supérieure pour éviter les pièces de 25 ou 50.
    // Ex: 1320 FCFA devient 1400 FCFA. C'est crucial pour la monnaie.
    return Math.ceil(finalPrice / 100) * 100;
};