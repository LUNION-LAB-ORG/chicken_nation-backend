import { UserRole } from '@prisma/client';

/**
 * Rôles qui TRAITENT les retours privés « Ton avis compte » (02/11) : journal
 * (appel, WhatsApp, note), statut et clôture, commande cochée, agent, ticket.
 *
 * L'administrateur et le call center, comptes de siège, sur tout le réseau.
 *
 * ⚠️ Liste de rôles et non `COMMENTAIRES UPDATE` : ce droit ouvre aussi la
 * curation des témoignages affichés sur le site et la correction du texte des
 * notes après commande, que le call center n'a pas à toucher. La lecture reste
 * gardée par `COMMENTAIRES READ` (marketing, manager et caissier compris), la
 * suppression par `COMMENTAIRES DELETE` (administrateur seul).
 *
 * Le back-office a la même liste (`peutTraiterAvis`) pour masquer les gestes :
 * les deux doivent bouger ensemble.
 */
export const ROLES_TRAITEMENT_AVIS = [UserRole.ADMIN, UserRole.CALL_CENTER] as const;
