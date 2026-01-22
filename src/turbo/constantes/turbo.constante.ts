import { PaiementMode } from "@prisma/client";

export const TURBO_API = {
    CREATION_COURSE: 'https://backend-prod.turbodeliveryapp.com/api/restaurant/course-externe/commande', // création d'une commande
    FRAIS_LIVRAISON: 'https://backend-prod.turbodeliveryapp.com/api/restaurant/course-externe/recupererLesFraisDuRestaurant', // récupération des frais de livraison
    LISTE_FRAIS: 'https://backend-prod.turbodeliveryapp.com/api/erp/frais-livraison/restaurant/listeFrais?page=0&size=10', // récupération de la liste des frais de livraison d'un restaurant
}

export const TURBO_API_KEY = 'jq3JVrMe10Isbdo2PR0OvdFUKRIFI61S';


export const mappingMethodPayment = {
    [PaiementMode.MOBILE_MONEY]: PaiementMode.MOBILE_MONEY,
    [PaiementMode.WALLET]: PaiementMode.WALLET,
    [PaiementMode.CARD]: PaiementMode.CARD,
    [PaiementMode.CASH]: PaiementMode.CASH,
}