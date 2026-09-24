import { randomInt } from 'crypto';
import {
  CrmCallOutcome,
  CrmStatus,
  EntityStatus,
  OrderStatus,
  PaymentMethod,
  Prisma,
} from '@prisma/client';

/**
 * Règles du module Contacts qui ne dépendent d'aucun service : elles sont
 * testées seules (conversion.rules.spec.ts) et partagées par tous les services.
 */

export const CRM_SETTINGS = {
  MAX_ATTEMPTS: 'crm.max_attempts',
  ALERT_DELAY_HOURS: 'crm.alert_delay_hours',
  WHATSAPP_TEMPLATE_SID: 'crm.whatsapp_template_sid',
  MESSAGE_TEMPLATE: 'crm.message_template',
  APP_LINK: 'crm.app_link',
  DEFAULT_OFFER_ID: 'crm.default_offer_id',
  INACTIVE_DAYS: 'crm.inactive_days',
} as const;

export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_ALERT_DELAY_HOURS = 48;
/** Un client qui a commandé devient « inactif » après ce nombre de jours sans commande. */
export const DEFAULT_INACTIVE_DAYS = 30;
export const DEFAULT_APP_LINK = 'https://www.chicken-nation.com/fr/app-mobile';
// Valable pour un inscrit comme pour un ancien client, et sans emoji : un
// emoji fait passer le SMS en Unicode, soit 3 segments facturés au lieu de 2.
export const DEFAULT_MESSAGE_TEMPLATE =
  "Bonjour {prenom} ! Chicken Nation vous offre {offre} avec le code {code}, valable jusqu'au {expiration}. Commandez ici : {lien}";

/** Événement socket émis vers le backoffice à chaque changement d'un contact. */
export const CRM_SOCKET_EVENT = 'crm:contact-updated';

/**
 * Une commande qui COMPTE : ni supprimée, ni paiement en ligne encore en
 * attente. Un paiement en ligne abandonné finit supprimé ; tant qu'il est en
 * cours, le client n'a pas encore commandé et doit rester dans la file.
 */
export function commandeEffective(customerId?: string): Prisma.OrderWhereInput {
  return {
    ...(customerId && { customer_id: customerId }),
    entity_status: { not: EntityStatus.DELETED },
    NOT: {
      payment_method: PaymentMethod.ONLINE,
      paied: false,
      status: OrderStatus.PENDING,
    },
  };
}

/**
 * Ce qui repart à zéro quand un client redevient inactif : le suivi en cours,
 * jamais l'historique (appels, coupons, journal restent attachés au contact).
 */
export const NOUVEAU_CYCLE = {
  status: CrmStatus.A_APPELER,
  assigned_to_id: null,
  assigned_at: null,
  campaign_id: null,
  call_count: 0,
  last_call_at: null,
  last_call_status_id: null,
  last_call_outcome: null,
  first_reached_at: null,
  qualified_at: null,
  callback_at: null,
  loss_reason_id: null,
  last_comment: null,
  coupon_sent_at: null,
  converted_at: null,
  conversion_order_id: null,
  conversion_amount: null,
} satisfies Prisma.CrmContactUncheckedUpdateManyInput;

/** Même remise à zéro, en SQL, pour les traitements par lots. */
export const NOUVEAU_CYCLE_SQL = Object.keys(NOUVEAU_CYCLE)
  .map((cle) => `"${cle}" = ${cle === 'status' ? `'A_APPELER'` : cle === 'call_count' ? '0' : 'NULL'}`)
  .join(', ');

/** Une commande qui compte, écrite en SQL pour la table "Order" aliasée « o ». */
export const COMMANDE_EFFECTIVE_SQL = `o."entity_status" <> 'DELETED'
  AND NOT (o."payment_method" = 'ONLINE' AND o."paied" = false AND o."status" = 'PENDING')`;

/** Nom de chaque public, tel qu'il s'affiche dans les exports et rapports. */
export const LIBELLES_PUBLIC: Record<string, string> = {
  JAMAIS_COMMANDE: 'Inscrit sans commande',
  INACTIF: 'Client inactif',
  GLOVO: 'Client Glovo',
  YANGO: 'Client Yango',
};

/** Issues où le client a décroché. */
export const OUTCOMES_JOINTS: CrmCallOutcome[] = [
  CrmCallOutcome.A_RAPPELER,
  CrmCallOutcome.INTERESSE,
  CrmCallOutcome.NON_INTERESSE,
];

/** Issues qui tranchent : le contact est qualifié. */
export const OUTCOMES_DEFINITIFS: CrmCallOutcome[] = [
  CrmCallOutcome.INTERESSE,
  CrmCallOutcome.NON_INTERESSE,
  CrmCallOutcome.NUMERO_INVALIDE,
];

/** Statuts encore à travailler par le call center. */
export const STATUTS_OUVERTS: CrmStatus[] = [
  CrmStatus.A_APPELER,
  CrmStatus.A_RAPPELER,
  CrmStatus.INTERESSE,
  CrmStatus.COUPON_ENVOYE,
];

/**
 * Statut du contact après un appel.
 *
 * Un appel ne fait jamais reculer un contact qui a déjà reçu son coupon,
 * sauf s'il dit clairement ne pas vouloir commander. Un « pas de réponse »
 * ne change rien, sauf quand il s'ajoute à trop de tentatives sur un numéro
 * qui n'a jamais décroché : le contact passe alors injoignable, pour ne pas
 * occuper la file indéfiniment.
 */
export function statutApresAppel(
  courant: CrmStatus,
  outcome: CrmCallOutcome,
  ctx: { dejaJoint: boolean; tentatives: number; maxTentatives: number },
): CrmStatus {
  const couponEnvoye = courant === CrmStatus.COUPON_ENVOYE;
  switch (outcome) {
    case CrmCallOutcome.NON_JOINT:
      if (
        courant === CrmStatus.A_APPELER &&
        !ctx.dejaJoint &&
        ctx.tentatives >= ctx.maxTentatives
      ) {
        return CrmStatus.INJOIGNABLE;
      }
      return courant;
    case CrmCallOutcome.A_RAPPELER:
      return couponEnvoye ? courant : CrmStatus.A_RAPPELER;
    case CrmCallOutcome.INTERESSE:
      return couponEnvoye ? courant : CrmStatus.INTERESSE;
    case CrmCallOutcome.NON_INTERESSE:
      return CrmStatus.NON_INTERESSE;
    case CrmCallOutcome.NUMERO_INVALIDE:
      return CrmStatus.INJOIGNABLE;
  }
}

/**
 * Statut reconstitué quand un contact « converti » redevient contact (sa
 * seule commande a été supprimée) : on repart de ce que le call center savait.
 */
export function statutSansConversion(p: {
  coupon_actif: boolean;
  last_call_outcome: CrmCallOutcome | null;
}): CrmStatus {
  if (p.coupon_actif) return CrmStatus.COUPON_ENVOYE;
  switch (p.last_call_outcome) {
    case CrmCallOutcome.A_RAPPELER:
      return CrmStatus.A_RAPPELER;
    case CrmCallOutcome.INTERESSE:
      return CrmStatus.INTERESSE;
    case CrmCallOutcome.NON_INTERESSE:
      return CrmStatus.NON_INTERESSE;
    case CrmCallOutcome.NUMERO_INVALIDE:
      return CrmStatus.INJOIGNABLE;
    default:
      return CrmStatus.A_APPELER;
  }
}

/** Numéro ivoirien au format attendu par Twilio : 225 + 10 chiffres. */
export function versE164(phone: string): string {
  const d = (phone || '').replace(/\D/g, '').slice(-10);
  return `225${d}`;
}

/** Prénom affichable dans un message, jamais « Bonjour  ! ». */
export function prenomPourMessage(firstName?: string | null): string {
  const p = (firstName ?? '').trim();
  return p ? p : 'cher client';
}

export function remplirModele(
  modele: string,
  vars: { prenom: string; offre: string; code: string; expiration: string; lien: string },
): string {
  return Object.entries(vars).reduce(
    (texte, [cle, valeur]) => texte.split(`{${cle}}`).join(valeur),
    modele,
  );
}

/** Jours de validité restants d'un coupon, arrondis au jour entamé (jamais moins de 1). */
export function joursRestants(expiration: Date, maintenant = new Date()): number {
  return Math.max(1, Math.ceil((expiration.getTime() - maintenant.getTime()) / 86_400_000));
}

/** Date lisible au téléphone : 31/12/2026. La Côte d'Ivoire vit à UTC+0. */
export function dateCourte(d: Date): string {
  const jj = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${jj}/${mm}/${d.getUTCFullYear()}`;
}

/** Nombre suivi de son nom accordé à la française : singulier sous 2 (« 1 traité », « 3 traités »). */
export function compter(n: number, singulier: string, pluriel = `${singulier}s`): string {
  return `${n} ${Math.abs(n) >= 2 ? pluriel : singulier}`;
}

/**
 * Code dicté au téléphone : sans 0/O ni 1/I/L, qu'on confond à l'oreille comme
 * à l'écrit. Tirage cryptographique, l'unicité est vérifiée par l'appelant.
 */
const ALPHABET_CODE = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function genererCodeCoupon(): string {
  let suffixe = '';
  for (let i = 0; i < 6; i++) suffixe += ALPHABET_CODE[randomInt(ALPHABET_CODE.length)];
  return `CN-${suffixe}`;
}
