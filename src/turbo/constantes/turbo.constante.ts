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
    /**
     * Annulation du groupe côté Turbo (CN → Turbo), utilisée par la REPRISE EN
     * INTERNE. Contrat : POST sans body, X-API-KEY ; 200 = annulé (idempotent),
     * 409 = un livreur a déjà accepté → reprise impossible, 404 = référence
     * inconnue. N'émet AUCUN webhook `cancelled` en écho (découplage).
     */
    ANNULATION_COURSE: (reference: string) =>
        `${TURBO_BASE}/api/restaurant/course-externe/${encodeURIComponent(reference)}/annuler`,
}

export const TURBO_API_KEY = 'jq3JVrMe10Isbdo2PR0OvdFUKRIFI61S';


export const mappingMethodPayment: Record<PaiementMode, PaiementMethode> = {
    [PaiementMode.MOBILE_MONEY]: PaiementMethode.MOBILE_MONEY,
    [PaiementMode.WALLET]: PaiementMethode.WAVE,
    [PaiementMode.CARD]: PaiementMethode.CARTE,
    [PaiementMode.CASH]: PaiementMethode.ESPECE,
}

/**
 * ENCAISSEMENT À LA LIVRAISON (Turbo → CN).
 *
 * Contrat validé avec Turbo : le livreur choisit le moyen de paiement du client
 * dans une liste FERMÉE de codes — les mêmes que le référentiel caissière du
 * backoffice (`paiement-data-select`). Turbo n'envoie JAMAIS la catégorie
 * comptable : c'est CN qui la dérive du code (piège évité : Wave = WALLET chez
 * nous, pas MOBILE_MONEY — classification KKiaPay).
 *
 * Tolérance déploiement asymétrique : code absent ou inconnu → espèces.
 */
export const ENCAISSEMENT_LIVREUR: Record<string, { mode: PaiementMode; source: string; label: string }> = {
    'cash': { mode: PaiementMode.CASH, source: 'cash', label: 'Espèces' },
    'orange-ci': { mode: PaiementMode.MOBILE_MONEY, source: 'orange-ci', label: 'Orange Money' },
    'mtn-ci': { mode: PaiementMode.MOBILE_MONEY, source: 'mtn-ci', label: 'MTN Mobile Money' },
    'moov-ci': { mode: PaiementMode.MOBILE_MONEY, source: 'moov-ci', label: 'MOOV Money' },
    'wave': { mode: PaiementMode.WALLET, source: 'wave', label: 'Wave' },
    'card': { mode: PaiementMode.CARD, source: 'card', label: 'Carte bancaire' },
}

/** Code Turbo → {mode, source, label} CN. Inconnu/absent = espèces (lecture tolérante). */
export function resoudreMoyenPaiement(code?: string | null): { mode: PaiementMode; source: string; label: string } {
    const cle = String(code ?? '').trim().toLowerCase();
    return ENCAISSEMENT_LIVREUR[cle] ?? ENCAISSEMENT_LIVREUR['cash'];
}
