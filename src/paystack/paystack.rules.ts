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
 * Règles de Chicken Nation :
 *  - Le paiement va sur le sous-compte du restaurant, frais Paystack portés
 *    par ce sous-compte. Le compte principal ne garde au plus que le taux
 *    des FRAIS DE SERVICE de la commande (réglage `order_tax_rate`, 1 % au
 *    25/11) : un sous-compte qui lui laisse davantage n'est pas utilisable.
 *  - FRAIS DE PAIEMENT (25/11) : Paystack n'ajoute rien au montant, c'est à
 *    nous de le préparer. Le client paie la commande (plats, frais de
 *    service, livraison) PLUS les frais du moyen choisi (Mobile Money ou
 *    carte), au taux réglé au back-office. Il choisit donc son moyen AVANT
 *    d'ouvrir la page de paiement, qui ne propose alors que ce moyen.
 */

export const DEVISE_PAYSTACK = 'XOF';
export const FACTEUR_XOF = 100;
export const API_PAYSTACK = 'https://api.paystack.co';
export const HOTE_CHECKOUT_PAYSTACK = 'checkout.paystack.com';
export const CANAUX_PAYSTACK = ['card', 'mobile_money'] as const;
/** IP d'où Paystack envoie ses webhooks (docs/payments/webhooks), test et live. */
export const IP_WEBHOOK_PAYSTACK = ['52.31.139.75', '52.49.173.169', '52.214.14.220'];

/** Moyen choisi par le client avant de payer. */
export type MoyenPaystack = 'mobile_money' | 'card';

export function lireMoyen(v: unknown): MoyenPaystack {
  return v === 'card' ? 'card' : 'mobile_money';
}

/** Taux des frais de paiement ajoutés au client, en pourcentage du total de la commande. */
export interface TauxFraisPaystack {
  mobileMoney: number;
  carte: number;
}

/**
 * Tarifs de Paystack en Côte d'Ivoire communiqués par le client le 25/11,
 * toutes taxes comprises : Mobile Money 2,3 %, carte locale 3,8 % (carte
 * internationale 4,5 % : le type de carte n'est connu qu'une fois la carte
 * saisie, un seul taux « carte » est donc appliqué). Rien de plus : le 1 %
 * du client est celui des frais de service, déjà dans la commande.
 */
export const TAUX_FRAIS_DEFAUT: TauxFraisPaystack = { mobileMoney: 2.3, carte: 3.8 };
export const TAUX_FRAIS_MAX = 20;

/** Taux lu dans un réglage : nombre de 0 à 20, deux décimales au plus ; sinon le défaut. */
export function lireTaux(valeur: unknown, defaut: number): number {
  const t = typeof valeur === 'number' ? valeur : typeof valeur === 'string' && valeur.trim() ? Number(valeur.replace(',', '.')) : Number.NaN;
  if (!Number.isFinite(t) || t < 0 || t > TAUX_FRAIS_MAX) return defaut;
  return Math.round(t * 100) / 100;
}

/** Taux payé par le client pour ce moyen. */
export function tauxClient(taux: TauxFraisPaystack, moyen: MoyenPaystack): number {
  return Math.round((moyen === 'card' ? taux.carte : taux.mobileMoney) * 100) / 100;
}

/**
 * Taux des frais de service en pourcentage, d'après le réglage
 * `order_tax_rate` (une fraction : « 0.01 » = 1 %). Illisible : 0.
 */
export function pourCentFraisService(reglage: unknown): number {
  const t = typeof reglage === 'number' ? reglage : typeof reglage === 'string' ? Number(reglage.replace(',', '.')) : Number.NaN;
  if (!Number.isFinite(t) || t < 0 || t > 1) return 0;
  return Math.round(t * 10_000) / 100;
}

/**
 * Frais ajoutés au montant de la commande, en francs, arrondis au franc
 * SUPÉRIEUR. Calcul en entiers (centièmes de pour-cent) : 10 000 F à 3,3 %
 * font 330 F, jamais 331.
 */
export function fraisClient(montant: number, moyen: MoyenPaystack, taux: TauxFraisPaystack): number {
  const m = Math.round(montant);
  if (!Number.isFinite(m) || m <= 0) return 0;
  const centiemes = Math.round(tauxClient(taux, moyen) * 100);
  // Entiers seulement : plafond de (m × centièmes) / 10 000.
  return Math.floor((m * centiemes + 9_999) / 10_000);
}

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

/** Domaines de premier niveau réservés aux essais : Paystack les refuse. */
const DOMAINES_FICTIFS = /\.(test|local|localhost|example|invalid)$/i;

/** Adresse technique stable, propre au client, qui ne révèle pas son numéro. */
export function emailTechnique(clientId: string, domaine = 'clients.chicken-nation.com'): string {
  const empreinte = createHash('sha256').update(`cn:${clientId}`, 'utf8').digest('hex').slice(0, 24);
  return `${empreinte}@${domaine}`;
}

/**
 * Paystack exige un e-mail valide. Celui du client s'il en a un plausible
 * (domaine avec une extension en lettres, hors domaines fictifs) ; sinon
 * l'adresse technique. Paystack reste juge : s'il refuse quand même
 * l'adresse, le paiement est relancé avec l'adresse technique
 * (`PaystackService.initialiser`).
 */
export function emailPourPaystack(email: string | null | undefined, clientId: string, domaine = 'clients.chicken-nation.com'): string {
  const e = (email ?? '').trim();
  if (/^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(e) && e.length <= 200 && !DOMAINES_FICTIFS.test(e)) return e;
  return emailTechnique(clientId, domaine);
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

/**
 * Un sous-compte encaisse pour Chicken Nation s'il est actif, en XOF (ou sans
 * devise lue), et ne laisse au compte principal pas plus que `partMax` (le
 * taux des frais de service, en pourcentage).
 */
export function motifSousCompteInutilisable(s: SousComptePaystack | null, partMax = 0): MotifSousCompte | null {
  if (!s) return 'INCONNU';
  if (!s.actif) return 'INACTIF';
  if (s.partComptePrincipal === null || s.partComptePrincipal > partMax + 1e-9) return 'PART_COMPTE_PRINCIPAL';
  if (s.devise && s.devise.toUpperCase() !== DEVISE_PAYSTACK) return 'DEVISE';
  return null;
}

const pourCent = (n: number | null) => (n === null ? 'une part inconnue' : `${String(n).replace('.', ',')} %`);

/** Le motif, en mots, pour l'écran d'administration. */
export function messageSousCompte(motif: MotifSousCompte, s: SousComptePaystack | null, partMax = 0): string {
  switch (motif) {
    case 'INCONNU':
      return 'Sous-compte introuvable chez Paystack.';
    case 'INACTIF':
      return 'Sous-compte inactif chez Paystack.';
    case 'DEVISE':
      return "Ce sous-compte n'encaisse pas en francs CFA (XOF).";
    case 'PART_COMPTE_PRINCIPAL':
      return `Ce sous-compte laisse ${pourCent(s?.partComptePrincipal ?? null)} au compte principal : le maximum est le taux des frais de service (${pourCent(partMax)}). Corrigez le pourcentage dans le tableau de bord Paystack, ou les frais de service.`;
  }
}

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
