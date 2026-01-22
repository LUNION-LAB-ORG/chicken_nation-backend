

// Interface pour la pagination
export class SortInfo {
    sorted: boolean
    empty: boolean
    unsorted: boolean
}

export class Pageable {
    pageNumber: number
    pageSize: number
    sort: SortInfo
    offset: number
    paged: boolean
    unpaged: boolean
}


export enum PaiementMethode {
    ESPECE = "ESPECE",
    CARTE = "CARTE",
    MOBILE_MONEY = "MOBILE_MONEY",
    WAVE = "WAVE"
}

export interface CommandeResponse {
    restaurantId: string;
    commandes: Commande[];
}

export interface Commande {
    numero: string;
    destinataire: Destinataire;
    lieuRecuperation: Localisation;
    lieuLivraison: Localisation;
    zoneId: string;
    modePaiement: PaiementMethode;
    prix: number;
    livraisonPaye: boolean;
}

export interface Destinataire {
    nomComplet: string;
    contact: string;
}

export interface Localisation {
    longitude: number;
    latitude: number;
}
