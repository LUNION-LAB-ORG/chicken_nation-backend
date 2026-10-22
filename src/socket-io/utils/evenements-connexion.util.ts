/**
 * Événement INTERNE (bus EventEmitter2) émis quand un livreur ouvre un socket.
 * Le module course lui renvoie alors son offre en attente : `course:offer:new`
 * émis pendant que l'appli était fermée n'est jamais rejoué par socket.io.
 * Charge : `{ delivererId }`.
 */
export const EVENEMENT_LIVREUR_CONNECTE = 'livreur.connecte';
