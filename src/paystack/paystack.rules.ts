import { createHash, randomBytes } from 'node:crypto';
import { PaiementMode, PaiementStatus } from '@prisma/client';

/**
 * PAYSTACK (25/11) : règles pures, sans appel réseau ni base.
 *
 * Faits lus dans la documentation de Paystack (25/11) :
 *  - XOF n'a pas de sous-unité, mais le montant s'envoie MULTIPLIÉ PAR 100
 *    (docs/api, « XOF subunit and fractions »).
 *  - `subaccount` dirige le paiement vers le sous-compte ; la part du compte
 *    principal est le `percentage_charge` du sous-compte, et les FRAIS
 *    Paystack sont par défaut payés par le compte principal : `bearer:
 *    "subaccount"` les fait porter par le sous-compte (docs/payments/split-payments).
 *  - Référence : lettres, chiffres, « - », « . » et « = » seulement.
 *  - Mobile Money en Côte d'Ivoire : MTN, Orange, Wave.
 *
 * Règle de Chicken Nation : l'argent va en ENTIER au sous-compte du
 * restaurant, rien sur le compte principal, frais compris. Un sous-compte qui
 * laisse une part au compte principal n'est pas utilisable.
 */

export const DEVISE_PAYSTACK = 'XOF';
export const FACTEUR_XOF = 100;
export const API_PAYSTACK = 'https://api.paystack.co';
export const HOTE_CHECKOUT_PAYSTACK = 'checkout.paystack.com';
export const CANAUX_PAYSTACK = ['card', 'mobile_money'] as const;
/** IP d'où Paystack envoie ses webhooks (docs/payments/webhooks), test et live. */
export const IP_WEBHOOK_PAYSTACK = ['52.31.139.75', '52.49.173.169', '52.214.14.220'];

/** Montant en francs (entier >= 1) vers l'unité de Paystack ; null si invalide. */
export function versUnitePaystack(francs: number): number | null {
  if (typeof francs !== 'number' || !Number.isFinite(francs)) return null;
  const entier = Math.round(francs);
  if (entier < 1 || Math.abs(entier - francs) > 0.001) return null;
  const v = entier * FACTEUR_XOF;
  return Number.isSafeInteger(v) ? v : null;
}

/** Montant de Paystack (nombre ou texte de chiffres) vers des francs ; null si illisible. */
export function depuisUnitePaystack(valeur: unknown): number | null {
  let n: number;
  if (typeof valeur === 'number') n = valeur;
  else if (typeof valeur === 'string' && /^\d+$/.test(valeur)) n = Number(valeur);
  else return null;
  if (!Number.isSafeInteger(n) || n < 0) return null;
  // Les fractions sont ignorées par Paystack : on arrondit au franc.
  return Math.round(n / FACTEUR_XOF);
}

/**
 * Paystack exige un e-mail. Celui du client s'il en a un valide ; sinon une
 * adresse technique stable, propre au client, qui ne révèle pas son numéro.
 */
export function emailPourPaystack(email: string | null | undefined, clientId: string, domaine = 'clients.chicken-nation.com'): string {
  const e = (email ?? '').trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 200) return e;
  const empreinte = createHash('sha256').update(`cn:${clientId}`, 'utf8').digest('hex').slice(0, 24);
  return `${empreinte}@${domaine}`;
}

/**
 * Référence d'une tentative : la référence de la commande, puis un suffixe
 * aléatoire (une commande peut être payée en plusieurs tentatives, chacune a
 * sa référence chez Paystack). Caractères permis par Paystack seulement.
 */
export function referenceTentative(referenceCommande: string, alea: () => string = () => randomBytes(4).toString('hex')): string {
  const base = (referenceCommande ?? '').replace(/[^A-Za-z0-9-]/g, '').slice(0, 60) || 'CMD';
  return `${base}-P${alea().replace(/[^A-Za-z0-9]/g, '').slice(0, 10).toUpperCase()}`;
}

/** Référence d'une tentative bien formée (avant toute lecture en base). */
export const REFERENCE_TENTATIVE = /^[A-Za-z0-9-]{1,60}-P[A-Z0-9]{1,10}$/;

/** Mode de la clé secrète ; null si ce n'est pas une clé secrète Paystack. */
export function modeDeCle(cle: string | null | undefined): 'test' | 'live' | null {
  const c = (cle ?? '').trim();
  if (/^sk_test_[A-Za-z0-9]{8,}$/.test(c)) return 'test';
  if (/^sk_live_[A-Za-z0-9]{8,}$/.test(c)) return 'live';
  return null;
}

/** Ce que l'on retient d'un sous-compte Paystack. */
export interface SousComptePaystack {
  code: string;
  nom: string | null;
  banque: string | null;
  compte: string | null;
  partComptePrincipal: number | null;
  actif: boolean;
  devise: string | null;
}

const objet = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const texte = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Numéro de compte masqué : seuls les 4 derniers chiffres restent. */
export function masquerCompte(numero: string | null): string | null {
  if (!numero) return null;
  const n = numero.replace(/\s/g, '');
  return n.length <= 4 ? n : `${'•'.repeat(Math.min(6, n.length - 4))}${n.slice(-4)}`;
}

/** Sous-compte lu dans une réponse de Paystack (GET /subaccount ou /subaccount/:code). */
export function lireSousCompte(brut: unknown): SousComptePaystack | null {
  const d = objet(brut);
  const code = texte(d.subaccount_code);
  if (!code) return null;
  const part = d.percentage_charge;
  return {
    code,
    nom: texte(d.business_name),
    banque: texte(d.settlement_bank),
    compte: masquerCompte(texte(d.account_number)),
    partComptePrincipal: typeof part === 'number' && Number.isFinite(part) ? part : typeof part === 'string' && /^\d+(\.\d+)?$/.test(part) ? Number(part) : null,
    actif: d.active !== false && d.is_verified !== false,
    devise: texte(d.currency),
  };
}

export type MotifSousCompte = 'INCONNU' | 'INACTIF' | 'PART_COMPTE_PRINCIPAL' | 'DEVISE';

/** Un sous-compte encaisse pour Chicken Nation s'il est actif, en XOF (ou sans devise lue) et laisse 0 % au compte principal. */
export function motifSousCompteInutilisable(s: SousComptePaystack | null): MotifSousCompte | null {
  if (!s) return 'INCONNU';
  if (!s.actif) return 'INACTIF';
  if (s.partComptePrincipal !== 0) return 'PART_COMPTE_PRINCIPAL';
  if (s.devise && s.devise.toUpperCase() !== DEVISE_PAYSTACK) return 'DEVISE';
  return null;
}

export const MESSAGES_SOUS_COMPTE: Record<MotifSousCompte, string> = {
  INCONNU: "Sous-compte introuvable chez Paystack.",
  INACTIF: "Sous-compte inactif chez Paystack.",
  PART_COMPTE_PRINCIPAL:
    "Ce sous-compte laisse une part au compte principal : mettez la part (pourcentage) à 0 dans le tableau de bord Paystack.",
  DEVISE: "Ce sous-compte n'encaisse pas en francs CFA (XOF).",
};

/** Transaction Paystack ramenée au vocabulaire du paiement de Chicken Nation. */
export interface TransactionPaystackLue {
  reference: string;
  statut: PaiementStatus;
  /** Statut brut de Paystack (success, failed, abandoned, ongoing…). */
  statutPaystack: string;
  montant: number | null;
  frais: number;
  devise: string | null;
  mode: PaiementMode;
  /** Opérateur ou carte, pour l'affichage (Wave, Orange Money, MTN, Visa…). */
  source: string | null;
  sousCompte: string | null;
  domaine: string | null;
  orderId: string | null;
  paieLe: string | null;
  motifEchec: string | null;
  client: { email: string | null; telephone: string | null } | null;
}

/** Opérateur lisible d'après `authorization.bank` ou `brand`. */
export function sourcePaystack(authorization: unknown, canal: string | null): string | null {
  const a = objet(authorization);
  const banque = `${texte(a.bank) ?? ''} ${texte(a.brand) ?? ''}`.toLowerCase();
  if (/wave/.test(banque)) return 'wave';
  if (/orange/.test(banque)) return 'orange';
  if (/mtn/.test(banque)) return 'mtn';
  if (/moov/.test(banque)) return 'moov';
  if (/visa/.test(banque)) return 'visa';
  if (/master/.test(banque)) return 'mastercard';
  return canal === 'mobile_money' ? 'mobile_money' : canal === 'card' ? 'card' : null;
}

const STATUTS: Record<string, PaiementStatus> = {
  success: PaiementStatus.SUCCESS,
  failed: PaiementStatus.FAILED,
  abandoned: PaiementStatus.FAILED,
  reversed: PaiementStatus.REVERTED,
};

/** Transaction lue dans la réponse de GET /transaction/verify/:reference. */
export function lireTransaction(brut: unknown, reference: string): TransactionPaystackLue {
  const d = objet(brut);
  const statutPaystack = texte(d.status)?.toLowerCase() ?? 'inconnu';
  const canal = texte(d.channel);
  const meta = objet(typeof d.metadata === 'string' ? safeJson(d.metadata) : d.metadata);
  const client = objet(d.customer);
  const auth = objet(d.authorization);
  return {
    reference: texte(d.reference) ?? reference,
    statut: STATUTS[statutPaystack] ?? PaiementStatus.FAILED,
    statutPaystack,
    montant: depuisUnitePaystack(d.amount),
    frais: depuisUnitePaystack(d.fees) ?? 0,
    devise: texte(d.currency)?.toUpperCase() ?? null,
    mode: canal === 'card' ? PaiementMode.CARD : PaiementMode.MOBILE_MONEY,
    source: sourcePaystack(auth, canal),
    sousCompte: texte(objet(d.subaccount).subaccount_code),
    domaine: texte(d.domain),
    orderId: texte(meta.order_id),
    paieLe: texte(d.paid_at) ?? texte(d.paidAt),
    motifEchec: statutPaystack === 'success' ? null : (texte(d.gateway_response) ?? statutPaystack).slice(0, 200),
    client: { email: texte(client.email), telephone: texte(client.phone) ?? texte(auth.mobile_money_number) },
  };
}

function safeJson(t: unknown): unknown {
  try {
    return JSON.parse(String(t));
  } catch {
    return null;
  }
}

/** Ce que la commande attend du paiement, pour contrôler la transaction vérifiée. */
export interface AttenduPaystack {
  reference: string;
  orderId: string;
  sousCompte: string | null;
  mode: 'test' | 'live';
}

/**
 * Motif qui interdit de rattacher la transaction à la commande, ou null. Le
 * montant n'est PAS contrôlé ici : la suite (comme pour KKiaPay) n'accepte
 * la commande que si les paiements réussis couvrent son total.
 */
export function motifTransactionRefusee(t: TransactionPaystackLue, attendu: AttenduPaystack): string | null {
  if (t.reference.toLowerCase() !== attendu.reference.toLowerCase()) return 'référence différente';
  if (t.domaine !== attendu.mode) return `transaction du mode ${t.domaine ?? 'inconnu'}, clé en mode ${attendu.mode}`;
  if (t.devise !== DEVISE_PAYSTACK) return `devise ${t.devise ?? 'inconnue'}`;
  if (t.orderId && t.orderId !== attendu.orderId) return 'transaction lancée pour une autre commande';
  if (attendu.sousCompte && t.sousCompte && t.sousCompte !== attendu.sousCompte) return 'encaissée sur un autre sous-compte';
  return null;
}

/** Statut d'une tentative d'après la transaction lue. */
export function statutTentative(t: Pick<TransactionPaystackLue, 'statutPaystack'>): 'PAYEE' | 'ECHEC' | 'ABANDON' | 'INITIEE' {
  if (t.statutPaystack === 'success') return 'PAYEE';
  if (t.statutPaystack === 'failed' || t.statutPaystack === 'reversed') return 'ECHEC';
  if (t.statutPaystack === 'abandoned') return 'ABANDON';
  return 'INITIEE';
}
