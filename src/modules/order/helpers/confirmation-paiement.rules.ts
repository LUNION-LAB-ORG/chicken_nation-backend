/**
 * CONFIRMATION MANUELLE D'UN PAIEMENT KKiaPay (demande du 14/11).
 *
 * Le client a payé, mais le webhook n'a pas confirmé la commande (refusé,
 * traitement en échec, ou jamais reçu) : elle reste en attente, dans « À
 * relancer ». L'agent la confirme avec l'identifiant de la transaction, que le
 * serveur revérifie TOUJOURS auprès de KKiaPay (`confirmPaymentManually`) :
 * aucun « forcer », impossible de marquer payé sans un paiement réussi qui
 * couvre la commande.
 *
 * Règles pures, partagées par la route administrateur
 * (`POST /orders/:id/confirm-payment`) et le geste de la relance
 * (`POST /orders/relances/:orderId/confirmer-paiement`).
 */

/**
 * Identifiant de transaction KKiaPay lisible : lettres, chiffres, puis « - »,
 * « _ » ou « . », 64 caractères au plus. Même alphabet que l'identifiant de
 * tâche du webhook (`KkiapayController`), qui y réduit déjà l'identifiant reçu.
 */
export const TRANSACTION_KKIAPAY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export const MESSAGE_TRANSACTION_ILLISIBLE =
  "Saisissez l'identifiant de la transaction KKiaPay : lettres et chiffres, sans espace.";

export const MESSAGE_KKIAPAY_INJOIGNABLE = 'KKiaPay ne répond pas : réessayez dans un instant.';

/** Identifiant nettoyé (espaces des bords retirés), ou null s'il est illisible. */
export function lireTransactionKkiapay(valeur: unknown): string | null {
  if (typeof valeur !== 'string') return null;
  const nettoye = valeur.trim();
  return TRANSACTION_KKIAPAY.test(nettoye) ? nettoye : null;
}

/**
 * Refus lisible d'une confirmation, à partir du motif rendu par le chemin du
 * webhook (`processTransactionSuccess` → `linkPaiementToOrder`). Un motif
 * inconnu passe tel quel : mieux vaut un mot technique qu'un refus muet.
 */
export function messageRefusConfirmation(motif?: string | null): string {
  switch (motif) {
    case 'transaction introuvable':
      return "KKiaPay ne connaît pas cette transaction sur le compte du restaurant : vérifiez l'identifiant.";
    case 'KKiaPay: statut non SUCCESS':
      return "KKiaPay indique que ce paiement n'a pas abouti : la commande reste en attente.";
    case 'Paystack: statut non SUCCESS':
      return "Paystack indique que ce paiement n'a pas abouti : la commande reste en attente.";
    case 'tentative inconnue':
      return 'Aucun paiement Paystack lancé pour cette commande.';
    case 'montant non couvert':
      return 'Le montant payé ne couvre pas la commande : elle reste en attente.';
    case 'commande introuvable':
      return 'Commande introuvable.';
    case 'erreur de traitement du paiement':
      return "Le paiement n'a pas pu être enregistré : réessayez dans un instant.";
    default:
      if (motif?.startsWith('Paystack: paiement non abouti')) {
        return "Le client n'a pas terminé le paiement sur Paystack : la commande reste en attente.";
      }
      return motif?.trim() || 'Confirmation du paiement impossible.';
  }
}

/**
 * Une transaction déjà enregistrée ne paie qu'UNE commande. Ailleurs que sur
 * la commande visée, le chemin du webhook la retrouvait sans la rattacher, et
 * répondait « montant non couvert » : l'agent croyait à une erreur de montant.
 *
 * @returns le refus à opposer, ou null si la transaction est libre ou déjà
 *   rattachée à cette commande (confirmation rejouée, sans effet de plus).
 */
export function refusTransactionDejaRattachee(
  orderId: string,
  enregistrements: { order_id: string | null; order?: { reference: string | null } | null }[],
): string | null {
  if (enregistrements.length === 0) return null;
  if (enregistrements.some((p) => p.order_id === orderId)) return null;
  const autre = enregistrements.find((p) => p.order_id);
  if (!autre) {
    return "Cette transaction KKiaPay est déjà enregistrée sans commande : voyez avec un administrateur.";
  }
  return autre.order?.reference
    ? `Cette transaction KKiaPay paie déjà la commande ${autre.order.reference}.`
    : 'Cette transaction KKiaPay paie déjà une autre commande.';
}
