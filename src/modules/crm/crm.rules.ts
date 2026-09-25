import { randomInt } from 'crypto';
import {
  CrmCallOutcome,
  CrmSegment,
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
  /** Posée au premier passage de la reprise acquisition : avant, les ventes sont « historique ». */
  BASCULE_ACQUISITION: 'crm.bascule_acquisition',
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

/**
 * Vente comptée dans les chiffres (alias `v` sur "CrmConversion") : ni annulée
 * au registre, ni portée par une commande annulée ou supprimée. Une commande
 * annulée laisse le client hors de la liste (règle du lot 1), mais ne compte
 * jamais comme vente, sur aucun écran.
 */
export const VENTE_VALIDE_SQL = `v."cancelled_at" IS NULL AND NOT EXISTS (
  SELECT 1 FROM "Order" ov WHERE ov."id" = v."order_id" AND (ov."status" = 'CANCELLED' OR ov."entity_status" = 'DELETED'))`;

/**
 * Ventes des fiches converties absentes du registre (alias x sur la fiche, o
 * sur sa commande). `bascule` : paramètre SQL de la date de bascule, avant
 * laquelle une commande Glovo/Yango est de l'historique d'acquisition.
 */
export const venteManquante = (bascule: string) => `
  SELECT gen_random_uuid(), x."id", x."cycle", x."segment", x."conversion_order_id", coalesce(x."conversion_amount", o."amount"),
         x."converted_at", o."restaurant_id", x."campaign_id", x."assigned_to_id",
         (CASE WHEN x."segment" IN ('GLOVO', 'YANGO') AND ${bascule}::timestamp IS NOT NULL AND o."created_at" < ${bascule}::timestamp
               THEN 'ACQUISITION_HISTORIQUE' ELSE 'CRM' END)::"CrmConversionSource"
  FROM "CrmContact" x JOIN "Order" o ON o."id" = x."conversion_order_id"
  WHERE x."status" = 'CONVERTI' AND x."entity_status" <> 'DELETED' AND x."converted_at" IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM "CrmConversion" v WHERE v."order_id" = x."conversion_order_id" AND v."cancelled_at" IS NULL)`;

export const COLONNES_VENTE = `("id", "contact_id", "cycle", "segment", "order_id", "amount", "converted_at",
  "restaurant_id", "campaign_id", "agent_id", "source")`;

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

/**
 * Issues où une raison de non-commande a un sens : le client a décroché sans
 * commander. Un client intéressé n'en a pas (l'ancienne est même effacée), et
 * un client qu'on n'a pas joint n'a rien pu dire.
 */
export const OUTCOMES_AVEC_RAISON: CrmCallOutcome[] = [CrmCallOutcome.A_RAPPELER, CrmCallOutcome.NON_INTERESSE];

/**
 * Raison à enregistrer pour un appel : celle choisie, seulement si l'issue en
 * admet une. Une raison restée choisie avant de passer à « Intéressé » (ou
 * envoyée par un écran plus ancien) est ignorée au lieu de marquer le client.
 */
export function raisonRetenue(outcome: CrmCallOutcome, raisonId?: string | null): string | undefined {
  return OUTCOMES_AVEC_RAISON.includes(outcome) && raisonId ? raisonId : undefined;
}

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

/** Numéro en chiffres, normalisé comme à la capture : sans le « 00 » international. */
export function chiffresTelephone(phone?: string | null): string {
  const d = (phone ?? '').replace(/\D/g, '');
  return d.startsWith('00') ? d.slice(2) : d;
}

/**
 * Clé de correspondance d'un numéro : ses 10 derniers chiffres. C'est ainsi
 * qu'une capture Glovo/Yango, un compte client et une fiche se retrouvent,
 * quel que soit le format saisi (« 07… », « 225 07… », « +225 07… »).
 */
export function cleTelephone(phone?: string | null): string | null {
  const d = chiffresTelephone(phone);
  return d.length >= 6 ? d.slice(-10) : null;
}

/**
 * Numéro au format attendu par Twilio (sans le « + », ajouté ensuite) : un
 * numéro ivoirien à 10 chiffres prend l'indicatif 225 ; un numéro qui porte
 * déjà son indicatif part tel quel, pour ne jamais écrire à un inconnu.
 */
export function versE164(phone: string): string {
  const d = chiffresTelephone(phone);
  return d.length === 10 ? `225${d}` : d;
}

/**
 * Public d'une NOUVELLE fiche pour un client qui a un compte, quand il est
 * relevé sur Glovo/Yango : ce qui est arrivé en premier l'emporte.
 *  - inscrit avant la capture, sans aucune commande : inscrit sans commande ;
 *  - devenu inactif avant la capture : client inactif ;
 *  - sinon (inscrit après, ou client encore actif) : client Glovo/Yango.
 * Même règle que la requalification des fiches existantes par la reprise :
 * le résultat ne dépend jamais de l'ordre dans lequel tournent les tâches.
 */
export function publicALaCapture(p: {
  plateforme: CrmSegment;
  capteLe: Date;
  inscritLe: Date | null;
  derniereCommande: Date | null;
  joursInactivite: number;
}): { segment: CrmSegment; depuis: Date } {
  if (!p.derniereCommande && p.inscritLe && p.inscritLe < p.capteLe) {
    return { segment: CrmSegment.JAMAIS_COMMANDE, depuis: p.inscritLe };
  }
  if (p.derniereCommande) {
    const inactifLe = new Date(p.derniereCommande.getTime() + p.joursInactivite * 86_400_000);
    if (inactifLe < p.capteLe) return { segment: CrmSegment.INACTIF, depuis: inactifLe };
  }
  return { segment: p.plateforme, depuis: p.capteLe };
}

/** Nom et numéro d'un contact, qu'il ait un compte sur l'application ou non. */
export function identiteContact(c: {
  name?: string | null;
  phone?: string | null;
  customer?: { first_name: string | null; last_name: string | null; phone: string | null; email?: string | null } | null;
}): { nom: string; prenom: string | null; telephone: string; email: string | null } {
  const compte = c.customer;
  const nomCompte = compte ? [compte.first_name, compte.last_name].filter(Boolean).join(' ').trim() : '';
  const nomCapture = (c.name ?? '').trim();
  return {
    nom: nomCompte || nomCapture || 'Client sans nom',
    prenom: compte?.first_name?.trim() || nomCapture.split(/\s+/).filter(Boolean).pop() || null,
    telephone: compte?.phone ?? c.phone ?? '',
    email: compte?.email ?? null,
  };
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

// ---------------------------------------------------------------------------
// Tableaux de bord par public (lot 3)
// ---------------------------------------------------------------------------

/** Ordre d'affichage des publics, partout. */
export const ORDRE_PUBLICS: CrmSegment[] = [
  CrmSegment.JAMAIS_COMMANDE,
  CrmSegment.INACTIF,
  CrmSegment.GLOVO,
  CrmSegment.YANGO,
];

/** Publics relevés en caisse (une capture ouvre leur passage). */
export const PUBLICS_CAPTES: CrmSegment[] = [CrmSegment.GLOVO, CrmSegment.YANGO];

/** Nom d'une ligne de tableau de bord (au pluriel : c'est un groupe de personnes). */
export const LIBELLES_LIGNE_PUBLIC: Record<string, string> = {
  JAMAIS_COMMANDE: 'Inscrits sans commande',
  INACTIF: 'Clients inactifs',
  GLOVO: 'Clients Glovo',
  YANGO: 'Clients Yango',
  CAPTES: 'Glovo + Yango',
  TOTAL: 'Total',
};

/** Première étape de l'entonnoir, selon le public. */
export const LIBELLES_ENTREE: Record<string, string> = {
  JAMAIS_COMMANDE: 'Inscrits',
  INACTIF: 'Devenus inactifs',
  GLOVO: 'Captés sur Glovo',
  YANGO: 'Captés sur Yango',
};

/** Dernière étape de l'entonnoir, selon le public. */
export const LIBELLES_CONVERSION: Record<string, string> = {
  JAMAIS_COMMANDE: 'Première commande',
  INACTIF: 'Reconquis',
  GLOVO: 'Commande directe',
  YANGO: 'Commande directe',
};

/**
 * Une commande qui compte ET qui n'est pas annulée (alias « o » sur "Order") :
 * c'est elle qui fait une vente, une seconde commande ou un « déjà client ».
 */
export const COMMANDE_VALIDE_SQL = `${COMMANDE_EFFECTIVE_SQL} AND o."status" <> 'CANCELLED'`;

/**
 * Coupon utilisé sur une commande qui compte (alias « c » sur "CrmCoupon") :
 * un coupon passé sur une commande annulée ou supprimée n'est pas « utilisé ».
 */
export const COUPON_UTILISE_SQL = `c."used_at" IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM "Order" oc WHERE oc."id" = c."order_id" AND (oc."status" = 'CANCELLED' OR oc."entity_status" = 'DELETED'))`;

/**
 * Publics demandés à un tableau de bord : le paramètre `segments` (plusieurs
 * publics) et l'ancien `segment`, fusionnés, sans doublon, dans l'ordre
 * d'affichage. Une liste vide veut dire « tous les publics ».
 */
export function publicsDe(q: { segment?: string | null; segments?: readonly string[] | null }): CrmSegment[] {
  const demandes = new Set<string>([...(q.segments ?? []), ...(q.segment ? [q.segment] : [])]);
  return ORDRE_PUBLICS.filter((p) => demandes.has(p));
}

/** Publics réellement couverts : ceux demandés, ou les quatre. */
export function porteePublics(publics: CrmSegment[]): CrmSegment[] {
  return publics.length ? publics : [...ORDRE_PUBLICS];
}

const JOUR_MS = 86_400_000;

/** Minuit UTC du jour d'une date « AAAA-MM-JJ… » ou d'un instant. */
export function jourUtc(d: string | Date): Date {
  const texte = typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10);
  return new Date(`${texte}T00:00:00.000Z`);
}

/**
 * Bornes d'une période de tableau de bord, en UTC : [from 00:00 ; to + 1 jour[.
 * Une borne absente reste ouverte.
 */
export function bornesPeriode(q: { from?: string | null; to?: string | null }): { debut: Date | null; fin: Date | null } {
  return {
    debut: q.from ? jourUtc(q.from) : null,
    fin: q.to ? new Date(jourUtc(q.to).getTime() + JOUR_MS) : null,
  };
}

/**
 * Bornes d'une vue par mois (cohortes) : les mois entiers qui touchent la
 * période, du premier jour du mois de `from` au premier jour du mois qui suit `to`.
 */
export function bornesMois(q: { from?: string | null; to?: string | null }): { debut: Date | null; fin: Date | null } {
  const debutMois = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const fin = q.to ? jourUtc(q.to) : null;
  return {
    debut: q.from ? debutMois(jourUtc(q.from)) : null,
    fin: fin ? new Date(Date.UTC(fin.getUTCFullYear(), fin.getUTCMonth() + 1, 1)) : null,
  };
}

/**
 * Un mois de cohorte « AAAA-MM » est-il complet pour une fenêtre de N jours ?
 * Oui quand le dernier entré du mois a eu ses N jours pleins.
 */
export function fenetreComplete(mois: string, jours: number, maintenant = new Date()): boolean {
  const [annee, m] = mois.split('-').map(Number);
  const finMois = Date.UTC(annee, m, 1);
  return finMois + jours * JOUR_MS <= maintenant.getTime();
}

/**
 * Première et dernière journée d'une série quotidienne. Sans `from`, la série
 * part du premier passage dans le CRM (« depuis l'ouverture ») ; au plus un
 * an de points, au-delà le graphique ne se lit plus.
 */
export function bornesTendance(p: {
  from?: string | null;
  to?: string | null;
  premierPassage: Date | null;
  maintenant?: Date;
}): { debut: Date; fin: Date } {
  const fin = jourUtc(p.to ?? p.maintenant ?? new Date());
  const demande = p.from ? jourUtc(p.from) : p.premierPassage ? jourUtc(p.premierPassage) : new Date(fin.getTime() - 29 * JOUR_MS);
  const auPlusTot = fin.getTime() - 365 * JOUR_MS;
  const debut = Math.min(Math.max(demande.getTime(), auPlusTot), fin.getTime());
  return { debut: new Date(debut), fin };
}

/** Part en pourcentage, à une décimale (0 quand le dénominateur est nul). */
export const pourcentage = (a: number, b: number): number => (b > 0 ? Math.round((a / b) * 1000) / 10 : 0);

/** Arrondi à `d` décimales ; `null` reste `null` (valeur non disponible). */
export function arrondiOuNul(n: number | null | undefined, d = 1): number | null {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return null;
  return Math.round(Number(n) * 10 ** d) / 10 ** d;
}

/**
 * Libellés des étapes extrêmes de l'entonnoir pour un ou plusieurs publics :
 * ceux du public quand il est seul, « Captés sur Glovo ou Yango » pour les
 * deux publics captés, sinon des libellés communs.
 */
export function libellesEntonnoir(publics: CrmSegment[]): { entree: string; conversion: string } {
  if (publics.length === 1) {
    return { entree: LIBELLES_ENTREE[publics[0]], conversion: LIBELLES_CONVERSION[publics[0]] };
  }
  if (publics.length === 2 && publics.every((p) => PUBLICS_CAPTES.includes(p))) {
    return { entree: 'Captés sur Glovo ou Yango', conversion: 'Commande directe' };
  }
  return { entree: 'Entrés dans le CRM', conversion: 'Conversions' };
}

/** Comptes des étapes emboîtées d'un entonnoir (chacune exige la précédente). */
export interface ComptesEntonnoir {
  entrees: number;
  contactes: number;
  joints: number;
  interesses: number;
  coupons: number;
  commandes: number;
}

export interface EtapeEntonnoir {
  cle: keyof ComptesEntonnoir;
  libelle: string;
  nombre: number;
  /** Part des entrés, en %. */
  part_entree: number;
  /** Ancien nom de `part_entree`, gardé une version pour la compatibilité. */
  part_inscrits: number;
  /** Part de l'étape précédente, en % (100 pour la première). */
  part_etape_precedente: number;
}

export function etapesEntonnoir(c: ComptesEntonnoir, publics: CrmSegment[]): EtapeEntonnoir[] {
  const { entree, conversion } = libellesEntonnoir(publics);
  const etapes: [keyof ComptesEntonnoir, string][] = [
    ['entrees', entree],
    ['contactes', 'Contactés'],
    ['joints', 'Joints'],
    ['interesses', 'Intéressés'],
    ['coupons', 'Coupon envoyé'],
    ['commandes', conversion],
  ];
  return etapes.map(([cle, libelle], i) => ({
    cle,
    libelle,
    nombre: c[cle],
    part_entree: pourcentage(c[cle], c.entrees),
    part_inscrits: pourcentage(c[cle], c.entrees),
    part_etape_precedente: i === 0 ? 100 : pourcentage(c[cle], c[etapes[i - 1][0]]),
  }));
}

/**
 * Pareto (cahier §7) : parts et cumul, et les lignes « principales », celles
 * qui entrent dans les 80 premiers pour cent (la ligne qui franchit 80 % en fait partie).
 */
export function pareto<T extends { nombre: number }>(
  lignes: T[],
): { total: number; lignes: (T & { part: number; cumul: number; principale: boolean })[] } {
  const triees = [...lignes].sort((a, b) => b.nombre - a.nombre);
  const total = triees.reduce((s, l) => s + l.nombre, 0);
  let cumul = 0;
  return {
    total,
    lignes: triees.map((l) => {
      const avant = cumul;
      cumul += l.nombre;
      // Seuil jugé sur la part exacte, pas sur l'arrondi (79,96 % reste sous 80 %).
      return { ...l, part: pourcentage(l.nombre, total), cumul: pourcentage(cumul, total), principale: total === 0 || avant < 0.8 * total };
    }),
  };
}

/**
 * Ligne d'un `GROUP BY GROUPING SETS ((segment), (groupe), ())` où `groupe`
 * vaut « CAPTES » pour Glovo et Yango, NULL sinon. `g_segment` et `g_groupe`
 * sont les valeurs de GROUPING() : 0 quand la colonne fait partie de la clé.
 */
export interface LigneGroupee {
  g_segment: number;
  g_groupe: number;
  segment: string | null;
  groupe: string | null;
}

/**
 * Range les lignes d'un GROUPING SETS : une par public, celle de Glovo + Yango
 * réunis, et le total. La ligne (groupe = NULL) des publics non captés est écartée.
 */
export function classerGroupes<T extends LigneGroupee>(
  lignes: T[],
): { parPublic: Map<CrmSegment, T>; captes: T | null; total: T | null } {
  const parPublic = new Map<CrmSegment, T>();
  let captes: T | null = null;
  let total: T | null = null;
  for (const l of lignes) {
    if (Number(l.g_segment) === 0 && l.segment) parPublic.set(l.segment as CrmSegment, l);
    else if (Number(l.g_groupe) === 0 && l.groupe === 'CAPTES') captes = l;
    else if (Number(l.g_segment) === 1 && Number(l.g_groupe) === 1) total = l;
  }
  return { parPublic, captes, total };
}

/**
 * Comptes bruts du devenir des passages entrés sur une période, tels que la
 * requête les rend (voir `CrmPublicsService.devenir`).
 */
export interface BrutDevenir {
  entrees: number;
  contactes: number;
  joints: number;
  interesses: number;
  coupons: number;
  commandes: number;
  ventes: number;
  hors_entonnoir: number;
  sans_contact: number;
  repris: number;
  ca: number;
  base_taux: number;
  ventes_base: number;
  mesurables_fenetre: number;
  ventes_fenetre: number;
  delai_median_j: number | null;
  delai_moyen_j: number | null;
  premier_appel_median_h: number | null;
  mesurables_j1: number;
  traites_j1: number;
  mesurables_j2: number;
  traites_j2: number;
  captes: number;
  deja_clients: number;
  ventes_deja_clients: number;
  deja_inscrits_a_la_capture: number;
  inscrits_apres_capture: number;
  sans_compte: number;
}

export const BRUT_DEVENIR_VIDE: BrutDevenir = {
  entrees: 0,
  contactes: 0,
  joints: 0,
  interesses: 0,
  coupons: 0,
  commandes: 0,
  ventes: 0,
  hors_entonnoir: 0,
  sans_contact: 0,
  repris: 0,
  ca: 0,
  base_taux: 0,
  ventes_base: 0,
  mesurables_fenetre: 0,
  ventes_fenetre: 0,
  delai_median_j: null,
  delai_moyen_j: null,
  premier_appel_median_h: null,
  mesurables_j1: 0,
  traites_j1: 0,
  mesurables_j2: 0,
  traites_j2: 0,
  captes: 0,
  deja_clients: 0,
  ventes_deja_clients: 0,
  deja_inscrits_a_la_capture: 0,
  inscrits_apres_capture: 0,
  sans_compte: 0,
};

/** Devenir des entrés, prêt à afficher (voir le contrat de l'API pour chaque champ). */
export interface Devenir extends ComptesEntonnoir {
  ventes: number;
  hors_entonnoir: number;
  sans_contact: number;
  repris: number;
  ca: number;
  taux_contact: number;
  taux_joint: number;
  base_taux: number;
  taux_conversion: number;
  mesurables_30j: number;
  ventes_30j: number;
  taux_30j: number;
  delai_median_j: number | null;
  delai_moyen_j: number | null;
  premier_appel_median_h: number | null;
  mesurables_j1: number;
  traites_j1: number;
  part_j1: number;
  mesurables_j2: number;
  traites_j2: number;
  part_j2: number;
  captes: number | null;
  deja_clients: number | null;
  ventes_deja_clients: number | null;
  deja_inscrits_a_la_capture: number | null;
  inscrits_apres_capture: number | null;
  sans_compte: number | null;
}

/**
 * Taux et délais du devenir, à partir des comptes bruts. `avecCaptes` : la
 * ligne couvre au moins un public capté (sinon les champs Glovo/Yango sont
 * `null`, « sans objet »).
 */
export function calculerDevenir(b: BrutDevenir, avecCaptes: boolean): Devenir {
  const n = (v: unknown) => Number(v ?? 0);
  const captes = (v: number) => (avecCaptes ? n(v) : null);
  return {
    entrees: n(b.entrees),
    contactes: n(b.contactes),
    joints: n(b.joints),
    interesses: n(b.interesses),
    coupons: n(b.coupons),
    commandes: n(b.commandes),
    ventes: n(b.ventes),
    hors_entonnoir: n(b.hors_entonnoir),
    sans_contact: n(b.sans_contact),
    repris: n(b.repris),
    ca: Math.round(n(b.ca)),
    taux_contact: pourcentage(n(b.contactes), n(b.entrees)),
    taux_joint: pourcentage(n(b.joints), n(b.contactes)),
    base_taux: n(b.base_taux),
    taux_conversion: pourcentage(n(b.ventes_base), n(b.base_taux)),
    mesurables_30j: n(b.mesurables_fenetre),
    ventes_30j: n(b.ventes_fenetre),
    taux_30j: pourcentage(n(b.ventes_fenetre), n(b.mesurables_fenetre)),
    delai_median_j: arrondiOuNul(b.delai_median_j),
    delai_moyen_j: arrondiOuNul(b.delai_moyen_j),
    premier_appel_median_h: arrondiOuNul(b.premier_appel_median_h),
    mesurables_j1: n(b.mesurables_j1),
    traites_j1: n(b.traites_j1),
    part_j1: pourcentage(n(b.traites_j1), n(b.mesurables_j1)),
    mesurables_j2: n(b.mesurables_j2),
    traites_j2: n(b.traites_j2),
    part_j2: pourcentage(n(b.traites_j2), n(b.mesurables_j2)),
    captes: captes(b.captes),
    deja_clients: captes(b.deja_clients),
    ventes_deja_clients: captes(b.ventes_deja_clients),
    deja_inscrits_a_la_capture: captes(b.deja_inscrits_a_la_capture),
    inscrits_apres_capture: captes(b.inscrits_apres_capture),
    sans_compte: captes(b.sans_compte),
  };
}

/**
 * Libellé d'une ligne de tableau de bord : un public, « Glovo + Yango » ou le total.
 */
export function libelleLigne(cle: CrmSegment | 'CAPTES' | 'TOTAL'): string {
  return LIBELLES_LIGNE_PUBLIC[cle] ?? cle;
}

// ---------------------------------------------------------------------------
// Cloisonnement par restaurant (compte de point de vente)
// ---------------------------------------------------------------------------

/**
 * Fiche « du restaurant R » : relevée à R sur Glovo/Yango (capture non
 * supprimée), ou dont le client a au moins une commande qui compte à R. Un
 * inscrit qui n'a jamais commandé n'est rattaché à aucun restaurant : aucun
 * compte de point de vente ne le voit.
 */
export function ficheDuRestaurant(restaurantId: string): Prisma.CrmContactWhereInput {
  return {
    OR: [
      { captures: { some: { restaurant_id: restaurantId, entity_status: { not: EntityStatus.DELETED } } } },
      { customer: { orders: { some: { ...commandeEffective(), restaurant_id: restaurantId } } } },
    ],
  };
}

/**
 * Même condition en SQL, sur une colonne qui porte l'id de la fiche
 * (« x.id », « k.contact_id », « v.contact_id »…). La sous-requête ne dépend
 * pas de la ligne : la base calcule une seule fois la liste des fiches du
 * restaurant, jamais une fois par ligne.
 */
export function ficheDuRestaurantSql(colonne: string, restaurantId: string): Prisma.Sql {
  return Prisma.sql`${Prisma.raw(colonne)} IN (
    SELECT rcap."contact_id" FROM "Prospect" rcap
    WHERE rcap."contact_id" IS NOT NULL AND rcap."entity_status" <> 'DELETED' AND rcap."restaurant_id" = ${restaurantId}::uuid
    UNION
    SELECT rx."id" FROM "CrmContact" rx JOIN "Order" o ON o."customer_id" = rx."customer_id"
    WHERE o."restaurant_id" = ${restaurantId}::uuid AND ${Prisma.raw(COMMANDE_EFFECTIVE_SQL)})`;
}
