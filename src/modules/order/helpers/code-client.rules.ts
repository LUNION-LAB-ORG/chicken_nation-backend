import { UserRole } from '@prisma/client';

/**
 * Code de retrait du client dans la section « Livraison » du tiroir d'une
 * commande (`GET /orders/:id/livraison`, champ `code_client`, demande du
 * 26/10).
 *
 * C'est `Order.recovery_code` : le code que le client présente pour récupérer
 * sa commande, dicté au livreur à la remise ou donné au comptoir
 * (`Delivery.delivery_pin` en est une copie). Ce n'est PAS le « Code retrait »
 * de la course (`pickup_code`), que le livreur donne à la caisse.
 *
 * Lu par l'administrateur et le call center seulement : un client qui a perdu
 * son code appelle le call center. Pour tout autre rôle, le champ est ABSENT
 * de la réponse : ni lu en base, ni renvoyé à `null`.
 *
 * ⚠️ Les autres réponses ne l'exposent pas davantage : `/courses` et
 * `/courses/:id` gardent `delivery_pin` à l'administrateur seul
 * (`includeCoursePour`), et l'écran Opérations ne l'a plus (24/10).
 */
export const ROLES_CODE_CLIENT: readonly UserRole[] = [UserRole.ADMIN, UserRole.CALL_CENTER];

export function peutLireCodeClient(compte: { role?: UserRole | string | null } | null | undefined): boolean {
  return !!compte?.role && (ROLES_CODE_CLIENT as readonly string[]).includes(compte.role);
}

/** Code tel qu'il est rendu : sans espace autour ; vide ou absent : `null`. */
export function codeClientRendu(code: string | null | undefined): string | null {
  const propre = typeof code === 'string' ? code.trim() : '';
  return propre ? propre : null;
}

/**
 * Une lecture par le call center est notée au journal d'audit, l'administrateur
 * non. Rien quand aucun code n'a été servi.
 */
export function lectureCodeClientANoter(
  compte: { role?: UserRole | string | null } | null | undefined,
  code: string | null,
): boolean {
  return compte?.role === UserRole.CALL_CENTER && code !== null;
}

/**
 * Le tiroir relit la section toutes les 20 s tant que la livraison n'est pas
 * finie : sans cette fenêtre, un tiroir ouvert une heure écrirait 180 lignes.
 * Une ligne par agent et par commande toutes les 10 minutes au plus.
 */
export const FENETRE_JOURNAL_CODE_CLIENT_MS = 10 * 60 * 1000;

export const ACTION_JOURNAL_CODE_CLIENT = 'CODE_CLIENT_LU';

/** Résumé de la ligne du journal. Le code n'y figure jamais. */
export function resumeJournalCodeClient(reference: string | null | undefined): string {
  return `Code de retrait du client consulté : commande ${reference || 'sans référence'}`;
}
