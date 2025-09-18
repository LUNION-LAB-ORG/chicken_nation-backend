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

export const LivraisonsByKm = [
    { maxKm: 5, price: 800 },
    { maxKm: 8, price: 1000 },
    { maxKm: 10, price: 1200 },
    { maxKm: 12, price: 1500 },
    { maxKm: 15, price: 1800 },
    { maxKm: 20, price: 2000 },
    { maxKm: 25, price: 2500 },
    { maxKm: 30, price: 3000 },
    { maxKm: 35, price: 3500 },
    { maxKm: 40, price: 4000 },
    { maxKm: Infinity, price: 5000 },
];