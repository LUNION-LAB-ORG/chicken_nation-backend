/**
 * Temps réel de la relance des paniers non payés.
 *
 * Un seul événement, `relance:changed`, émis dans la salle des relances
 * (`SALLE_RELANCES`, rôles ADMIN et CALL_CENTER). Il ne porte AUCUNE donnée
 * personnelle : le navigateur n'en tire jamais de compteur, il relit
 * `GET /orders/relances`.
 *
 * Émetteurs, et eux seuls :
 *  - les gestes d'agent (prise, libération, ignorer, rétablir) ;
 *  - la tâche d'alerte (passage du délai, ou prise expirée sans traitement) ;
 *  - la reprise au téléphone (bascule d'une commande de l'application vers le
 *    personnel, dans `OrderService.update`).
 * La vie ordinaire des commandes (création, paiement, annulation) passe par
 * les événements `order:*`, que le backoffice relit déjà : la requête des
 * relances vit sous la clé `['order', 'relances', ...]` et en profite.
 */
export const RELANCE_SOCKET_EVENT = 'relance:changed';

export type MotifRelanceChanged =
  | 'alerte'
  | 'prise'
  | 'liberation'
  | 'ignore'
  | 'retablissement'
  | 'reprise';

export interface RelanceChangedPayload {
  motif: MotifRelanceChanged;
  /** Identifiants des commandes concernées. */
  ids: string[];
  /** Motif « alerte » seulement : têtes de groupe qui viennent de sonner. Vide sinon. */
  nouvelles: string[];
  /** Identifiant de l'agent auteur du geste, absent pour la tâche d'alerte. */
  par?: string;
}

/** Actions du journal `OrderRelanceJournal.action`. */
export const ACTIONS_JOURNAL_RELANCE = {
  ALERTE: 'ALERTE',
  PRISE: 'PRISE',
  LIBERATION: 'LIBERATION',
  IGNORE: 'IGNORE',
  RETABLISSEMENT: 'RETABLISSEMENT',
  REPRISE: 'REPRISE',
} as const;
