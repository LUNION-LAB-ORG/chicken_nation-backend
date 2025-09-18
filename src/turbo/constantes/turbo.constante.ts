import { PaiementMode } from "@prisma/client";

export const TURBO_API = {
    CREATION_COURSE: 'https://backend-prod.turbodeliveryapp.com/api/restaurant/course-externe/commande',
    FRAIS_LIVRAISON: 'https://backend-prod.turbodeliveryapp.com/api/restaurant/course-externe/recupererLesFraisDuRestaurant',
    LISTE_FRAIS: 'https://backend-prod.turbodeliveryapp.com/api/erp/frais-livraison/restaurant/listeFrais?page=0&size=10',
}

export const TURBO_API_KEY = 'jq3JVrMe10Isbdo2PR0OvdFUKRIFI61S';



export const mappingMethodPayment = {
    [PaiementMode.MOBILE_MONEY]: "MOBILE_MONEY",
    [PaiementMode.WALLET]: "WAVE",
    [PaiementMode.CREDIT_CARD]: "CARD",
    [PaiementMode.CASH]: "ESPECE",
}