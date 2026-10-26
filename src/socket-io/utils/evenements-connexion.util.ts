/**
 * Événement INTERNE (bus EventEmitter2) émis quand un livreur ouvre un socket.
 * Le module course lui renvoie alors son offre en attente : `course:offer:new`
 * émis pendant que l'appli était fermée n'est jamais rejoué par socket.io.
 * Charge : `{ delivererId }`.
 */
export const EVENEMENT_LIVREUR_CONNECTE = 'livreur.connecte';

/**
 * Événement INTERNE émis à la fin de CHAQUE socket d'un livreur, avec la
 * raison donnée par socket.io (retour du client du 25/10) :
 *  - `client namespace disconnect` : l'appli a fermé elle-même son socket
 *    (appli glissée hors des récentes, écran détruit, compte déconnecté) ;
 *  - `ping timeout` : plus rien ne passe (réseau coupé, appli gelée par le
 *    téléphone) ;
 *  - `transport close` : connexion fermée net (processus de l'appli tué) ;
 *  - `server namespace disconnect`, `server shutting down`, `transport error`…
 * Gardé par `FinsSocketLivreursService` : « Appli fermée » ou « Connexion
 * coupée ». Charge : `LivreurDeconnecte`.
 */
export const EVENEMENT_LIVREUR_DECONNECTE = 'livreur.deconnecte';

/** Charge de `EVENEMENT_LIVREUR_DECONNECTE`. */
export interface LivreurDeconnecte {
  delivererId: string;
  /** Raison socket.io de la fin du socket. */
  raison: string;
  /** Heure de la fin (ISO). */
  a: string;
}
