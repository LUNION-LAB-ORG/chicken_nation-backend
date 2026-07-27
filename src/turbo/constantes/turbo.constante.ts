import { PaiementMode } from "@prisma/client";
import { PaiementMethode } from "../interfaces/turbo.interfaces";

const TURBO_BASE = 'https://backend-prod.turbodeliveryapp.com';

export const TURBO_API = {
    CREATION_COURSE: `${TURBO_BASE}/api/restaurant/course-externe/commande`, // création d'une commande (ou d'un GROUPE : `commandes` accepte N entrées)
    FRAIS_LIVRAISON: `${TURBO_BASE}/api/restaurant/course-externe/recupererLesFraisDuRestaurant`, // récupération des frais de livraison
    LISTE_FRAIS: `${TURBO_BASE}/api/erp/frais-livraison/restaurant/listeFrais`, // récupération de la liste des frais de livraison d'un restaurant
    /**
     * Confirmation du RETRAIT par la caissière Chicken Nation.
     * Chez CN c'est la caissière — jamais le livreur — qui atteste la remise des
     * plats (garde-fou anti-fraude). Turbo n'a aucun moyen de le savoir : c'est
     * donc CN qui le leur signale, ce qui passe le groupe en « récupéré » et
     * déclenche leur `picked_up`. `{reference}` = référence de la course CN.
     */
    CONFIRMATION_RETRAIT: (reference: string) =>
        `${TURBO_BASE}/api/restaurant/course-externe/${encodeURIComponent(reference)}/retrait-confirme`,
}

export const TURBO_API_KEY = 'jq3JVrMe10Isbdo2PR0OvdFUKRIFI61S';


export const mappingMethodPayment: Record<PaiementMode, PaiementMethode> = {
    [PaiementMode.MOBILE_MONEY]: PaiementMethode.MOBILE_MONEY,
    [PaiementMode.WALLET]: PaiementMethode.WAVE,
    [PaiementMode.CARD]: PaiementMethode.CARTE,
    [PaiementMode.CASH]: PaiementMethode.ESPECE,
}
