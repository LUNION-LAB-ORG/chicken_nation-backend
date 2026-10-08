import { CodeAlerte } from 'src/modules/alertes/alertes.service';
import { PaiementStatus } from '@prisma/client';

/**
 * Une commande terminée est-elle réellement impayée ?
 *
 * ⚠️ Règle PURE, sans base ni horloge : c'est elle qu'on teste, et c'est elle
 * qui décide. La tâche planifiée se contente de lui présenter des commandes.
 *
 * ⚠️ `paied` FAIT FOI, et rien d'autre. Une commande manuelle réglée au
 * restaurant est marquée payée sans qu'une ligne de paiement existe forcément.
 * Ne regarder que ces lignes faisait crier « aucun paiement » sur une commande
 * que tous les écrans affichent « Payé », puisque le badge lit ce même
 * drapeau. Une alerte qui contredit l'écran n'alerte plus personne.
 */

/** Écart d'arrondi de taxe entre l'application et le serveur : pas un impayé. */
export const TOLERANCE_IMPAYE = 50;

/**
 * Délai avant de crier. Le paiement arrive parfois bien APRÈS la fin de la
 * commande : un cas mesuré en production montrait 1 h 00 min 15 s d'écart, et
 * l'alerte partait à la seconde du changement de statut. 90 minutes couvrent
 * ce retard sans repousser l'alerte hors de la journée d'exploitation.
 */
export const MINUTES_AVANT_ALERTE_IMPAYE = Number(process.env.ALERTE_IMPAYE_MINUTES ?? 90);

export interface CommandeAJuger {
  amount: number;
  paied?: boolean;
  paiements?: { status: PaiementStatus; amount: number; total?: number | null }[];
}

export interface Anomalie {
  code: CodeAlerte.COMMANDE_SANS_PAIEMENT | CodeAlerte.PAIEMENT_PARTIEL;
  du: number;
  encaisse: number;
  details: string[];
}

/** `null` = rien à signaler. */
export function anomaliePaiement(commande: CommandeAJuger): Anomalie | null {
  if (commande.paied) return null;

  const du = Number(commande.amount) || 0;
  if (du <= 0) return null;

  const encaisse = (commande.paiements ?? [])
    .filter((p) => p.status === PaiementStatus.SUCCESS)
    .reduce((somme, p) => somme + (p.total ?? p.amount ?? 0), 0);

  if (encaisse <= 0) {
    return {
      code: CodeAlerte.COMMANDE_SANS_PAIEMENT,
      du,
      encaisse,
      details: [`Montant dû : ${du} F`, 'Aucun paiement enregistré sur cette commande.'],
    };
  }

  if (encaisse < du - TOLERANCE_IMPAYE) {
    return {
      code: CodeAlerte.PAIEMENT_PARTIEL,
      du,
      encaisse,
      details: [`Encaissé ${encaisse} F sur ${du} F`, `Reste ${du - encaisse} F à percevoir.`],
    };
  }

  return null;
}
