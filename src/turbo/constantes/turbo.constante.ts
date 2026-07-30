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

export interface IEncaissementDeclare {
    mode: PaiementMode;
    source: string;
    label: string;
    montant: number;
}

/**
 * Normalise la déclaration d'encaissement d'un livreur (Turbo OU interne) en
 * lignes {mode, source, label, montant} AGRÉGÉES PAR MOYEN.
 *
 * PAIEMENT PARTAGÉ : le client peut régler en plusieurs moyens (une partie
 * Wave + une partie Orange Money). Formats acceptés, du plus riche au plus
 * simple (lecture tolérante, clés camelCase ou snake_case) :
 *   1. `encaissements: [{ moyenPaiement, montantEncaisse }, …]` — liste ;
 *   2. `moyenPaiement` + `montantEncaisse` — champ simple (montant absent →
 *      montant total) ;
 *   3. rien → espèces pour le montant total.
 * Deux lignes du même moyen sont fusionnées (l'index unique partiel n'accepte
 * qu'un PENDING par commande et par moyen).
 */
export function normaliserEncaissements(
    input: {
        encaissements?: unknown;
        moyenPaiement?: unknown;
        montantEncaisse?: unknown;
    },
    montantTotal: number,
): IEncaissementDeclare[] {
    const lignes: IEncaissementDeclare[] = [];

    if (Array.isArray(input.encaissements)) {
        for (const brut of input.encaissements) {
            const e = (brut ?? {}) as Record<string, unknown>;
            const moyen = resoudreMoyenPaiement(
                (e.moyenPaiement ?? e.moyen_paiement ?? e.moyen) as string | undefined,
            );
            const montant = Number(e.montantEncaisse ?? e.montant_encaisse ?? e.montant);
            if (!Number.isFinite(montant) || montant <= 0) continue;
            const existante = lignes.find((l) => l.source === moyen.source);
            if (existante) existante.montant += montant;
            else lignes.push({ ...moyen, montant });
        }
    }
    if (lignes.length > 0) return lignes;

    // Champ simple (ou rien) : un seul moyen pour le montant total.
    const moyen = resoudreMoyenPaiement(input.moyenPaiement as string | undefined);
    const montantBrut = Number(input.montantEncaisse);
    const montant =
        Number.isFinite(montantBrut) && montantBrut > 0 ? montantBrut : montantTotal;
    return [{ ...moyen, montant }];
}

/** « 1 200 XOF en Wave + 800 XOF en Orange Money » — pour cloches et logs. */
export function libelleEncaissements(lignes: IEncaissementDeclare[]): string {
    return lignes
        .map((l) => `${l.montant.toLocaleString('fr-FR')} XOF en ${l.label}`)
        .join(' + ');
}
