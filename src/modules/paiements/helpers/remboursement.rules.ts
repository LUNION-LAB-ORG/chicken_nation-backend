/**
 * REMBOURSEMENT KKiaPay depuis l'onglet Paiement d'une commande (12/11) :
 * règles pures, testées par `remboursement.rules.spec.ts`.
 *
 * D'abord on vérifie, auprès du compte KKiaPay qui a encaissé, que la
 * transaction existe et qu'elle est bien payée, pour le montant du paiement ;
 * ensuite seulement on tente le remboursement. Administrateur partout,
 * manager sur les commandes de SON restaurant.
 */
import { PaiementMode, PaiementStatus, UserRole, UserType } from '@prisma/client';

/** Rôles qui remboursent (garde de la route ; le restaurant se vérifie au cas par cas). */
export const ROLES_REMBOURSEMENT = [UserRole.ADMIN, UserRole.MANAGER] as const;

/** Écart toléré entre le montant KKiaPay et celui du paiement (arrondi de frais). */
export const TOLERANCE_MONTANT = 50;

/** Au-delà, une demande restée sans suite (serveur arrêté en route) ne bloque plus. */
export const DELAI_DEMANDE_MS = 2 * 60_000;

/** Préfixe des références des encaissements saisis à la main (espèces, mobile money au restaurant). */
const PREFIXE_MANUEL = 'PAY-';

// ─── Messages ────────────────────────────────────────────────────────────────

export const MESSAGE_INTROUVABLE = 'Paiement introuvable.';
export const MESSAGE_DROIT = 'Le remboursement est réservé à l’administrateur et au manager du restaurant de la commande.';
export const MESSAGE_MANUEL =
  "Ce paiement a été enregistré à la main : il n'est pas passé par KKiaPay et ne se rembourse pas ici.";
export const MESSAGE_DEJA_REMBOURSE = 'Ce paiement a déjà été remboursé.';
export const MESSAGE_PAS_REUSSI = 'Seul un paiement réussi peut être remboursé.';
export const MESSAGE_INCONNUE = 'KKiaPay ne connaît pas cette transaction sur le compte qui l’a encaissée.';
export const MESSAGE_DEJA_REMBOURSE_KKIAPAY =
  "KKiaPay indique que cette transaction est déjà remboursée. Enregistrez-le ici pour que la commande le dise.";
export const MESSAGE_CHANGE = 'Le paiement a changé entre-temps. Relancez la vérification.';
export const MESSAGE_EN_COURS = 'Un remboursement de ce paiement est déjà en cours.';
export const MESSAGE_INCERTAIN =
  "KKiaPay n'a pas répondu clairement : le remboursement est peut-être passé. Relancez la vérification avant de réessayer.";
export const MESSAGE_PAS_REMBOURSE_KKIAPAY = "KKiaPay n'indique pas cette transaction comme remboursée.";

// ─── Qui ─────────────────────────────────────────────────────────────────────

export interface Acteur {
  id: string;
  role: UserRole;
  type: UserType;
  restaurant_id: string | null;
}

/**
 * Administrateur (compte du siège) : toute commande. Manager : les commandes
 * de SON restaurant seulement. Un paiement sans commande : administrateur seul.
 */
export function peutRembourser(u: Acteur, restaurantCommande: string | null | undefined): boolean {
  if (u.role === UserRole.ADMIN && u.type !== UserType.RESTAURANT) return true;
  return (
    u.role === UserRole.MANAGER &&
    u.type === UserType.RESTAURANT &&
    !!u.restaurant_id &&
    !!restaurantCommande &&
    u.restaurant_id === restaurantCommande
  );
}

// ─── Quoi ────────────────────────────────────────────────────────────────────

/** Paiement passé par KKiaPay : une référence de transaction, pas un encaissement saisi à la main. */
export function estPaiementKkiapay(p: { reference: string | null | undefined; mode: PaiementMode }): boolean {
  const ref = (p.reference ?? '').trim();
  return !!ref && !ref.toUpperCase().startsWith(PREFIXE_MANUEL) && p.mode !== PaiementMode.CASH;
}

/** Statut KKiaPay en majuscules (« success » → « SUCCESS »), vide s'il manque. */
export function statutKkiapay(t: { status?: unknown } | null | undefined): string {
  return typeof t?.status === 'string' ? t.status.trim().toUpperCase() : '';
}

/** KKiaPay dit la transaction remboursée (son vocabulaire exact n'est pas documenté). */
export function estRembourseeChezKkiapay(t: { status?: unknown } | null | undefined): boolean {
  return /REVERT|REFUND|REMBOURS/.test(statutKkiapay(t));
}

export const LIBELLE_STATUT_KKIAPAY: Record<string, string> = {
  SUCCESS: 'Payée',
  FAILED: 'Échouée',
  PENDING: 'En attente',
  INSUFFICIENT_FUND: 'Fonds insuffisants',
};

export function libelleStatutKkiapay(t: { status?: unknown } | null | undefined): string {
  if (estRembourseeChezKkiapay(t)) return 'Remboursée';
  const s = statutKkiapay(t);
  return LIBELLE_STATUT_KKIAPAY[s] ?? (s || 'Inconnu');
}

/** « 6 060 F » avec des espaces ordinaires. */
export function montantLisible(n: number): string {
  return `${String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} F`;
}

export interface BilanRemboursement {
  /** On peut demander le remboursement à KKiaPay. */
  remboursable: boolean;
  /** KKiaPay l'a déjà remboursée : on peut seulement l'enregistrer chez nous. */
  constatable: boolean;
  /** Pourquoi ni l'un ni l'autre, ou ce qu'il faut savoir ; null quand tout va. */
  raison: string | null;
}

/**
 * Ce que permet la vérification. Prudent : un montant qui ne correspond pas,
 * un statut autre que « payée », une transaction inconnue du compte
 * encaisseur, et rien ne part.
 */
export function bilanRemboursement(
  paiement: { status: PaiementStatus; amount: number; total: number | null; rembourse_at?: Date | null },
  transaction: { status?: unknown; amount?: unknown } | null,
): BilanRemboursement {
  const non = (raison: string, constatable = false): BilanRemboursement => ({ remboursable: false, constatable, raison });
  if (paiement.status === PaiementStatus.REVERTED || paiement.rembourse_at) return non(MESSAGE_DEJA_REMBOURSE);
  if (paiement.status !== PaiementStatus.SUCCESS) return non(MESSAGE_PAS_REUSSI);
  if (!transaction) return non(MESSAGE_INCONNUE);
  if (estRembourseeChezKkiapay(transaction)) return non(MESSAGE_DEJA_REMBOURSE_KKIAPAY, true);
  const statut = statutKkiapay(transaction);
  if (statut !== 'SUCCESS') {
    return non(`KKiaPay indique que cette transaction n'est pas payée (${libelleStatutKkiapay(transaction).toLowerCase()}) : rien à rembourser.`);
  }
  const montant = Number(transaction.amount);
  const candidats = [paiement.amount, paiement.total ?? paiement.amount].filter((m) => Number.isFinite(m) && m > 0);
  if (!Number.isFinite(montant) || !candidats.some((m) => Math.abs(m - montant) <= TOLERANCE_MONTANT)) {
    return non(
      `Le montant chez KKiaPay (${Number.isFinite(montant) ? montantLisible(montant) : 'inconnu'}) ne correspond pas à ce paiement (${montantLisible(paiement.amount)}). Remboursement bloqué par prudence.`,
    );
  }
  return { remboursable: true, constatable: false, raison: null };
}

/** Le refus de KKiaPay, en mots (codes de ses kits : TRANSACTION_NOT_ELIGIBLE, NOT_FOUND, INVALID). */
export function messageRefusKkiapay(code: string | null, raison: string | null): string {
  const c = (code ?? '').toUpperCase();
  if (c.includes('NOT_ELIGIBLE')) {
    return 'KKiaPay refuse : la transaction est déjà remboursée ou ne peut pas l’être. Vérifiez-la sur le tableau de bord KKiaPay.';
  }
  if (c.includes('NOT_FOUND')) return 'KKiaPay refuse : il ne trouve pas cette transaction.';
  if (c.includes('INVALID')) return "KKiaPay refuse : cette transaction n'appartient pas au compte utilisé.";
  return `KKiaPay refuse le remboursement${raison ? ` : ${raison}` : '.'}`;
}
