export enum PaiementChannels {
    PAIEMENT_SUCCESS = 'paiement.effectue',
    PAIEMENT_CANCEL = 'paiement.annule',
    /**
     * Commande EN ATTENTE soldée par un paiement ajouté à la main (14/11) :
     * le module des commandes la confirme (`CommandeSoldeeListener`).
     */
    COMMANDE_EN_ATTENTE_SOLDEE = 'paiement.commande_en_attente_soldee',
}