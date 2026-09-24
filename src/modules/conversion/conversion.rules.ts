import { randomInt } from 'crypto';
import {
  ConversionCallOutcome,
  ConversionProspectStatus,
  EntityStatus,
  OrderStatus,
  PaymentMethod,
  Prisma,
} from '@prisma/client';

/**
 * Règles du module Prospects qui ne dépendent d'aucun service : elles sont
 * testées seules (conversion.rules.spec.ts) et partagées par tous les services.
 */

export const CONVERSION_SETTINGS = {
  MAX_ATTEMPTS: 'conversion.max_attempts',
  ALERT_DELAY_HOURS: 'conversion.alert_delay_hours',
  WHATSAPP_TEMPLATE_SID: 'conversion.whatsapp_template_sid',
  MESSAGE_TEMPLATE: 'conversion.message_template',
  APP_LINK: 'conversion.app_link',
  DEFAULT_OFFER_ID: 'conversion.default_offer_id',
} as const;

export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_ALERT_DELAY_HOURS = 48;
export const DEFAULT_APP_LINK = 'https://www.chicken-nation.com/fr/app-mobile';
export const DEFAULT_MESSAGE_TEMPLATE =
  "Bonjour {prenom} ! Bienvenue chez Chicken Nation 🍗 Voici votre code {code} : {offre}, valable jusqu'au {expiration}. Commandez ici : {lien}";

/** Événement socket émis vers le backoffice à chaque changement d'un prospect. */
export const CONVERSION_SOCKET_EVENT = 'conversion:prospect-updated';

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

/** Issues où le client a décroché. */
export const OUTCOMES_JOINTS: ConversionCallOutcome[] = [
  ConversionCallOutcome.A_RAPPELER,
  ConversionCallOutcome.INTERESSE,
  ConversionCallOutcome.NON_INTERESSE,
];

/** Issues qui tranchent : le prospect est qualifié. */
export const OUTCOMES_DEFINITIFS: ConversionCallOutcome[] = [
  ConversionCallOutcome.INTERESSE,
  ConversionCallOutcome.NON_INTERESSE,
  ConversionCallOutcome.NUMERO_INVALIDE,
];

/** Statuts encore à travailler par le call center. */
export const STATUTS_OUVERTS: ConversionProspectStatus[] = [
  ConversionProspectStatus.A_APPELER,
  ConversionProspectStatus.A_RAPPELER,
  ConversionProspectStatus.INTERESSE,
  ConversionProspectStatus.COUPON_ENVOYE,
];

/**
 * Statut du prospect après un appel.
 *
 * Un appel ne fait jamais reculer un prospect qui a déjà reçu son coupon,
 * sauf s'il dit clairement ne pas vouloir commander. Un « pas de réponse »
 * ne change rien, sauf quand il s'ajoute à trop de tentatives sur un numéro
 * qui n'a jamais décroché : le prospect passe alors injoignable, pour ne pas
 * occuper la file indéfiniment.
 */
export function statutApresAppel(
  courant: ConversionProspectStatus,
  outcome: ConversionCallOutcome,
  ctx: { dejaJoint: boolean; tentatives: number; maxTentatives: number },
): ConversionProspectStatus {
  const couponEnvoye = courant === ConversionProspectStatus.COUPON_ENVOYE;
  switch (outcome) {
    case ConversionCallOutcome.NON_JOINT:
      if (
        courant === ConversionProspectStatus.A_APPELER &&
        !ctx.dejaJoint &&
        ctx.tentatives >= ctx.maxTentatives
      ) {
        return ConversionProspectStatus.INJOIGNABLE;
      }
      return courant;
    case ConversionCallOutcome.A_RAPPELER:
      return couponEnvoye ? courant : ConversionProspectStatus.A_RAPPELER;
    case ConversionCallOutcome.INTERESSE:
      return couponEnvoye ? courant : ConversionProspectStatus.INTERESSE;
    case ConversionCallOutcome.NON_INTERESSE:
      return ConversionProspectStatus.NON_INTERESSE;
    case ConversionCallOutcome.NUMERO_INVALIDE:
      return ConversionProspectStatus.INJOIGNABLE;
  }
}

/**
 * Statut reconstitué quand un prospect « converti » redevient prospect (sa
 * seule commande a été supprimée) : on repart de ce que le call center savait.
 */
export function statutSansConversion(p: {
  coupon_actif: boolean;
  last_call_outcome: ConversionCallOutcome | null;
}): ConversionProspectStatus {
  if (p.coupon_actif) return ConversionProspectStatus.COUPON_ENVOYE;
  switch (p.last_call_outcome) {
    case ConversionCallOutcome.A_RAPPELER:
      return ConversionProspectStatus.A_RAPPELER;
    case ConversionCallOutcome.INTERESSE:
      return ConversionProspectStatus.INTERESSE;
    case ConversionCallOutcome.NON_INTERESSE:
      return ConversionProspectStatus.NON_INTERESSE;
    case ConversionCallOutcome.NUMERO_INVALIDE:
      return ConversionProspectStatus.INJOIGNABLE;
    default:
      return ConversionProspectStatus.A_APPELER;
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
