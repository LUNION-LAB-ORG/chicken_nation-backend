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
 * ⚠️ Les autres réponses ne l'exposent pas davantage :
 *  - les routes du personnel sur les commandes (`GET /orders`,
 *    `GET /orders/:id`, création, modification, statut, encaissement,
 *    suppression) passent par `commandePourLePersonnel` : `recovery_code` et
 *    `delivery.delivery_pin` n'en sortent que pour ces deux rôles (26/10 : le
 *    tiroir d'une commande lit `GET /orders/:id` pour tous les rôles, la
 *    caissière et le suivi des livraisons y lisaient le code) ;
 *  - la fiche d'un client (`GET /customer/:id`) ne lit pas `recovery_code` de
 *    ses commandes ;
 *  - `/courses` et `/courses/:id` gardent `delivery_pin` à l'administrateur
 *    seul (`includeCoursePour`), et l'écran Opérations ne l'a plus (24/10) ;
 *  - les diffusions au restaurant et au back office le retirent
 *    (`sanitizeOrderForBroadcast`).
 * Le client garde son code sur ses propres routes (`/orders/:id/client`…).
 */
export const ROLES_CODE_CLIENT: readonly UserRole[] = [UserRole.ADMIN, UserRole.CALL_CENTER];

export function peutLireCodeClient(compte: { role?: UserRole | string | null } | null | undefined): boolean {
  return !!compte?.role && (ROLES_CODE_CLIENT as readonly string[]).includes(compte.role);
}

function estObjet(valeur: unknown): valeur is Record<string, unknown> {
  return !!valeur && typeof valeur === 'object' && !Array.isArray(valeur);
}

/**
 * Copie d'une commande sans le code de retrait du client : `recovery_code`, et
 * sa copie `delivery.delivery_pin` quand la livraison est incluse. Le reste
 * est rendu tel quel ; l'original n'est pas modifié.
 */
export function sansCodeClient<T>(commande: T): T {
  if (!estObjet(commande)) return commande;
  const { recovery_code: _code, ...reste }: Record<string, unknown> = commande;
  if (estObjet(reste.delivery)) {
    const { delivery_pin: _pin, ...livraison } = reste.delivery;
    reste.delivery = livraison;
  }
  return reste as T;
}

/**
 * Commande rendue par une route du personnel : telle quelle pour
 * l'administrateur et le call center, sans le code de retrait du client pour
 * tous les autres rôles.
 */
export function commandePourLePersonnel<T>(
  compte: { role?: UserRole | string | null } | null | undefined,
  commande: T,
): T {
  return peutLireCodeClient(compte) ? commande : sansCodeClient(commande);
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
