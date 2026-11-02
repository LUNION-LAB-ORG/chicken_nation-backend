import { BadRequestException } from '@nestjs/common';
import {
  AvisCanal,
  AvisResultat,
  AvisRessenti,
  AvisSolution,
  AvisStatut,
  AvisSuiviType,
  Prisma,
} from '@prisma/client';
import { createHash } from 'crypto';
import { normaliserTelephoneClient } from 'src/common/utils/customer-phone.util';

/**
 * Règles des retours privés « Ton avis compte » (page /fr/avis du site, 02/11).
 *
 * Fonctions SANS base : le dépôt public, la liste, la fiche, le traitement et
 * la tâche de retard les appellent, les tests les prouvent une à une. Le
 * back-office et le site en ont des jumelles (libellés, sources, rôles) : une
 * ligne changée ici se change là-bas.
 *
 * Contrat qui fait foi : .banc-test-crm/avis/contrat-avis.md.
 */

const MINUTE = 60_000;
const HEURE = 60 * MINUTE;

/** Échéance de rappel : 24 h après la réception. */
export const DELAI_ECHEANCE_MS = 24 * HEURE;
export const COMMENTAIRE_MIN = 2;
export const COMMENTAIRE_MAX = 1000;
export const PRENOM_MAX = 60;
export const NOTE_MAX = 2000;
/** Extrait du commentaire dans la liste. */
export const EXTRAIT_LISTE = 120;
/** Extrait du commentaire dans la cloche. */
export const EXTRAIT_CLOCHE = 80;
/** Lignes au plus dans un export. */
export const EXPORT_MAX = 5000;
/** Commandes montrées sur la fiche. */
export const DERNIERES_COMMANDES = 5;

// ─── Barrières de l'envoi public ─────────────────────────────────────────────

/** Avis par numéro sur 24 heures. */
export const MAX_AVIS_PAR_NUMERO = 3;
export const FENETRE_NUMERO_MS = 24 * HEURE;
/** Avis par heure, tous numéros confondus (`AVIS_MAX_PAR_HEURE`). */
export const MAX_AVIS_PAR_HEURE_DEFAUT = 200;
export const FENETRE_GLOBALE_MS = HEURE;
/** Un double appui sur « Envoyer » dans ces 10 minutes ne crée pas de second avis. */
export const DELAI_DOUBLON_MS = 10 * MINUTE;
/** Envois par adresse IP (garde de la route). */
export const LIMITE_IP = { limit: 5, ttl: 15 * MINUTE } as const;

export const MESSAGE_NUMERO = 'Saisis un numéro mobile à 10 chiffres (07, 05 ou 01).';
export const MESSAGE_STORE = "Ce store n'existe plus. Choisis-en un autre.";
export const MESSAGE_COMMENTAIRE = "Raconte-nous ce qui s'est passé.";
export const MESSAGE_PLAFOND_NUMERO =
  "Tu nous as déjà écrit plusieurs fois aujourd'hui. Appelle-nous au 27 21 71 21 30.";
export const MESSAGE_PLAFOND_GLOBAL = "Trop d'avis en ce moment. Réessaie dans quelques minutes.";
export const MESSAGE_PLAFOND_IP = "Trop d'envois depuis cette connexion. Réessaie dans quelques minutes.";

// ─── Messages du personnel ──────────────────────────────────────────────────

export const MESSAGE_CONFLIT = "L'avis a changé entre-temps. Recharge la fiche.";
export const MESSAGE_INTROUVABLE = 'Avis introuvable.';
export const MESSAGE_SOLUTION = 'La solution est obligatoire pour Résolu.';
export const MESSAGE_INCIDENT_MANUEL = 'Passer par Créer un incident.';
export const MESSAGE_NOUVEAU_MANUEL = "Le statut « Nouveau » n'est jamais posé à la main.";
export const MESSAGE_SANS_ACCORD = "Pas d'accord de rappel : ni appel ni WhatsApp.";
export const MESSAGE_SANS_ACCORD_STATUT = "Pas d'accord de rappel : ce statut n'est pas possible.";
export const MESSAGE_RESULTAT = 'Choisis le résultat.';
export const MESSAGE_RESULTAT_WHATSAPP = 'Un message WhatsApp est Joint ou Injoignable.';
export const MESSAGE_NOTE = 'Écris la note.';
export const MESSAGE_NOTE_LONGUE = 'La note ne doit pas dépasser 2 000 caractères.';
export const MESSAGE_NON_RAPPROCHE = 'Client non rapproché.';
export const MESSAGE_SANS_COMMANDE = "Cocher d'abord la commande concernée.";
export const MESSAGE_COMMANDE_AUTRE = "Cette commande n'est pas celle de ce client.";
export const MESSAGE_AGENT = 'Cet agent ne traite pas les avis.';
export const MESSAGE_CATEGORIE = 'Catégorie de ticket introuvable.';

// ─── Mots (3.1) ──────────────────────────────────────────────────────────────

export const LIBELLE_RESSENTI: Record<AvisRessenti, string> = {
  PAS_CONTENT: 'Pas content',
  PEUT_MIEUX_FAIRE: 'Peut mieux faire',
  AU_TOP: 'Au top',
};

/** Ce que le client a choisi sur le site. */
export const LIBELLE_CANAL_SITE: Record<AvisCanal, string> = {
  APPLI: 'Appli Chicken Nation',
  SITE_WEB: 'Site web',
  TELEPHONE: 'Téléphone',
  WHATSAPP: 'WhatsApp',
  SUR_PLACE: 'Sur place en store',
  AUTRE_PLATEFORME: 'Autre plateforme',
};

/** À l'écran du back-office : une commande prise par téléphone s'appelle « Manuel ». */
export const LIBELLE_CANAL_ECRAN: Record<AvisCanal, string> = {
  APPLI: 'Appli',
  SITE_WEB: 'Site web',
  TELEPHONE: 'Manuel',
  WHATSAPP: 'WhatsApp',
  SUR_PLACE: 'Sur place',
  AUTRE_PLATEFORME: 'Autre plateforme',
};

/** Export CSV : « Téléphone », le client a refusé « Manuel » dans les exports (03/10). */
export const LIBELLE_CANAL_EXPORT: Record<AvisCanal, string> = {
  ...LIBELLE_CANAL_ECRAN,
  TELEPHONE: 'Téléphone',
};

export const LIBELLE_STATUT: Record<AvisStatut, string> = {
  NOUVEAU: 'Nouveau',
  A_RAPPELER: 'À rappeler',
  EN_COURS: 'En cours',
  INJOIGNABLE: 'Injoignable',
  INCIDENT_OUVERT: 'Incident ouvert',
  RESOLU: 'Résolu',
  CLASSE: 'Classé',
};

export const LIBELLE_SOLUTION: Record<AvisSolution, string> = {
  EXCUSES: 'Excuses',
  GESTE_COMMERCIAL: 'Geste commercial',
  REMPLACEMENT: 'Remplacement',
  REMBOURSEMENT: 'Remboursement',
  AUCUNE: 'Aucune',
};

export const LIBELLE_RESULTAT: Record<AvisResultat, string> = {
  JOINT: 'Joint',
  INJOIGNABLE: 'Injoignable',
  MESSAGERIE: 'Messagerie',
};

export const ACTIONS_JOURNAL = ['APPEL', 'WHATSAPP', 'NOTE'] as const;
export type ActionJournal = (typeof ACTIONS_JOURNAL)[number];

export const LIBELLE_ACTION: Record<ActionJournal, string> = {
  APPEL: 'Appel',
  WHATSAPP: 'Message WhatsApp',
  NOTE: 'Note interne',
};

/**
 * Sources de la liste blanche (QR codes imprimés). Toute autre valeur, ou son
 * absence, devient `site`. Ajouter une source = une ligne ici et la même au
 * back-office.
 */
export const SOURCES: Record<string, string> = {
  'marque-page': 'QR code marque-page',
  ticket: 'QR code ticket de caisse',
  sac: 'QR code sac',
  site: 'Site web',
};
export const SOURCE_PAR_DEFAUT = 'site';

export function sourceAutorisee(brut: unknown): string {
  if (typeof brut !== 'string') return SOURCE_PAR_DEFAUT;
  const code = brut.trim().toLowerCase();
  if (!/^[a-z0-9-]{1,40}$/.test(code)) return SOURCE_PAR_DEFAUT;
  return Object.prototype.hasOwnProperty.call(SOURCES, code) ? code : SOURCE_PAR_DEFAUT;
}

export function libelleSource(code: string): string {
  return SOURCES[code] ?? SOURCES[SOURCE_PAR_DEFAUT];
}

// ─── Saisie publique ────────────────────────────────────────────────────────

/** Mobile ivoirien canonique : +225 puis 01, 05 ou 07 et huit chiffres. */
const MOBILE_CI = /^\+2250[157]\d{8}$/;

/** Numéro saisi → `+2250…` canonique, ou `null` s'il n'est pas un mobile ivoirien. */
export function mobileIvoirien(brut: unknown): string | null {
  const canonique = normaliserTelephoneClient(brut);
  return canonique && MOBILE_CI.test(canonique) ? canonique : null;
}

/**
 * Commentaire enregistré : retours chariot ramenés à `\n`, tabulations
 * changées en espaces, autres caractères de contrôle retirés (le retour à la
 * ligne reste), espaces de bord retirés.
 */
export function nettoyerCommentaire(brut: string): string {
  return (brut ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '')
    .trim();
}

/** Prénom enregistré : une ligne, espaces resserrés, `null` s'il est vide. */
export function nettoyerPrenom(brut: unknown): string | null {
  if (typeof brut !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const propre = brut.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  return propre ? propre.slice(0, PRENOM_MAX) : null;
}

/** Empreinte d'un commentaire pour reconnaître un double appui (casse et espaces ignorés). */
export function empreinteCommentaire(commentaire: string): string {
  const normalise = commentaire.toLowerCase().replace(/\s+/g, ' ').trim();
  return createHash('sha1').update(normalise).digest('hex');
}

export function chiffres(telephone: string): string {
  return telephone.replace(/\D/g, '');
}

// ─── Statut initial et échéance (3.2) ────────────────────────────────────────

/** Statuts où l'échéance court encore. */
export const STATUTS_ECHEANCE: AvisStatut[] = [
  AvisStatut.A_RAPPELER,
  AvisStatut.EN_COURS,
  AvisStatut.INJOIGNABLE,
];

/** « Non traités » : en tête de liste quand le client n'est pas content. */
export const STATUTS_NON_TRAITES: AvisStatut[] = [
  AvisStatut.NOUVEAU,
  AvisStatut.A_RAPPELER,
  AvisStatut.EN_COURS,
  AvisStatut.INJOIGNABLE,
];

export const STATUTS_CLOS: AvisStatut[] = [AvisStatut.RESOLU, AvisStatut.CLASSE];

/**
 * Statut et échéance d'un avis à sa réception : « À rappeler » sous 24 h
 * seulement si le client a donné son accord ET n'est pas pleinement content.
 */
export function etatInitial(
  ressenti: AvisRessenti,
  accordRappel: boolean,
  recuLe: Date,
): { statut: AvisStatut; echeance_at: Date | null } {
  if (accordRappel && ressenti !== AvisRessenti.AU_TOP) {
    return {
      statut: AvisStatut.A_RAPPELER,
      echeance_at: new Date(recuLe.getTime() + DELAI_ECHEANCE_MS),
    };
  }
  return { statut: AvisStatut.NOUVEAU, echeance_at: null };
}

interface EtatEcheance {
  echeance_at: Date | null;
  premier_contact_at: Date | null;
  statut: AvisStatut;
}

/** L'échéance court : posée, pas encore tenue par un « Joint », avis ni en incident ni clos. */
export function echeanceActive(a: EtatEcheance): boolean {
  return !!a.echeance_at && !a.premier_contact_at && STATUTS_ECHEANCE.includes(a.statut);
}

export function enRetard(a: EtatEcheance, maintenant: Date): boolean {
  return echeanceActive(a) && (a.echeance_at as Date).getTime() < maintenant.getTime();
}

/** Échéance à montrer : `null` quand elle est sans objet. */
export function echeanceAffichee(a: EtatEcheance): Date | null {
  return echeanceActive(a) ? a.echeance_at : null;
}

/** Même condition que `enRetard`, en SQL, sur l'alias `a` de "AvisPrive". */
export function sqlEnRetard(maintenant: Date): Prisma.Sql {
  return Prisma.sql`(a.echeance_at IS NOT NULL AND a.premier_contact_at IS NULL
    AND a.statut::text IN (${Prisma.join(STATUTS_ECHEANCE)})
    AND a.echeance_at < ${maintenant})`;
}

// ─── Journal : saisie et effets (3.3) ───────────────────────────────────────

export interface EntreeJournal {
  action: ActionJournal;
  resultat: AvisResultat | null;
  note: string | null;
}

/**
 * Contrôle une saisie du journal. Appel et WhatsApp : accord de rappel exigé,
 * résultat obligatoire (WhatsApp : Joint ou Injoignable). Note interne : la
 * note est obligatoire, un résultat éventuel est ignoré.
 */
export function verifierEntreeJournal(
  saisie: { action: ActionJournal; resultat?: AvisResultat | null; note?: string | null },
  accordRappel: boolean,
): EntreeJournal {
  const note = typeof saisie.note === 'string' ? saisie.note.trim() : '';
  if (note.length > NOTE_MAX) throw new BadRequestException(MESSAGE_NOTE_LONGUE);

  if (saisie.action === 'NOTE') {
    if (!note) throw new BadRequestException(MESSAGE_NOTE);
    return { action: 'NOTE', resultat: null, note };
  }

  if (!accordRappel) throw new BadRequestException(MESSAGE_SANS_ACCORD);
  const resultat = saisie.resultat ?? null;
  if (!resultat) throw new BadRequestException(MESSAGE_RESULTAT);
  if (saisie.action === 'WHATSAPP' && resultat === AvisResultat.MESSAGERIE) {
    throw new BadRequestException(MESSAGE_RESULTAT_WHATSAPP);
  }
  return { action: saisie.action, resultat, note: note || null };
}

/**
 * Effets d'une ligne du journal sur l'avis, calculés sur le statut LU :
 *  - Joint : premier contact (échéance tenue) ; Nouveau, À rappeler,
 *    Injoignable → En cours ;
 *  - Injoignable ou Messagerie : Nouveau, À rappeler → Injoignable ;
 *  - un appel compte une tentative ; une note ne change rien.
 */
export function effetsJournal(
  statutLu: AvisStatut,
  entree: EntreeJournal,
  dejaContacte: boolean,
): { statut: AvisStatut; premierContact: boolean; tentative: boolean } {
  let statut = statutLu;
  let premierContact = false;
  if (entree.resultat === AvisResultat.JOINT) {
    premierContact = !dejaContacte;
    if (
      statutLu === AvisStatut.NOUVEAU ||
      statutLu === AvisStatut.A_RAPPELER ||
      statutLu === AvisStatut.INJOIGNABLE
    ) {
      statut = AvisStatut.EN_COURS;
    }
  } else if (entree.resultat === AvisResultat.INJOIGNABLE || entree.resultat === AvisResultat.MESSAGERIE) {
    if (statutLu === AvisStatut.NOUVEAU || statutLu === AvisStatut.A_RAPPELER) {
      statut = AvisStatut.INJOIGNABLE;
    }
  }
  return { statut, premierContact, tentative: entree.action === 'APPEL' };
}

// ─── Clôture et changement de statut (3.4) ──────────────────────────────────

export interface ChangementStatut {
  statut: AvisStatut;
  solution: AvisSolution | null;
  resolu_at?: Date | null;
  clos_at?: Date | null;
}

/**
 * Données à écrire pour passer l'avis de `actuel` à `cible`, ou 400.
 * Résolu exige une solution ; Classé la prend si elle est donnée ; toute autre
 * cible l'ignore. Quitter Résolu ou Classé rouvre l'avis (dates et solution
 * remises à vide). Reposer le même statut clos garde ses dates.
 */
export function changementStatut(p: {
  actuel: AvisStatut;
  cible: AvisStatut;
  solution?: AvisSolution | null;
  accordRappel: boolean;
  maintenant: Date;
}): ChangementStatut {
  const { actuel, cible, accordRappel, maintenant } = p;
  if (cible === AvisStatut.NOUVEAU) throw new BadRequestException(MESSAGE_NOUVEAU_MANUEL);
  if (cible === AvisStatut.INCIDENT_OUVERT) throw new BadRequestException(MESSAGE_INCIDENT_MANUEL);
  if ((cible === AvisStatut.A_RAPPELER || cible === AvisStatut.INJOIGNABLE) && !accordRappel) {
    throw new BadRequestException(MESSAGE_SANS_ACCORD_STATUT);
  }
  const solution = p.solution ?? null;
  if (cible === AvisStatut.RESOLU) {
    if (!solution) throw new BadRequestException(MESSAGE_SOLUTION);
    return actuel === AvisStatut.RESOLU
      ? { statut: cible, solution }
      : { statut: cible, solution, resolu_at: maintenant, clos_at: maintenant };
  }
  if (cible === AvisStatut.CLASSE) {
    return actuel === AvisStatut.CLASSE
      ? { statut: cible, solution }
      : { statut: cible, solution, resolu_at: null, clos_at: maintenant };
  }
  return { statut: cible, solution: null, resolu_at: null, clos_at: null };
}

/** Données d'un passage en « Incident ouvert » : un avis clos est rouvert. */
export function passageIncident(actuel: AvisStatut): ChangementStatut {
  return STATUTS_CLOS.includes(actuel)
    ? { statut: AvisStatut.INCIDENT_OUVERT, solution: null, resolu_at: null, clos_at: null }
    : { statut: AvisStatut.INCIDENT_OUVERT, solution: null };
}

// ─── Tri par défaut (3.9) ───────────────────────────────────────────────────

/** « Pas content » encore à traiter : en tête, du plus ancien au plus récent. */
export function prioritaire(a: { ressenti: AvisRessenti; statut: AvisStatut }): boolean {
  return a.ressenti === AvisRessenti.PAS_CONTENT && STATUTS_NON_TRAITES.includes(a.statut);
}

/** Jumeau JavaScript de `SQL_TRI` (tests). */
export function comparerAvis(
  a: { id: string; ressenti: AvisRessenti; statut: AvisStatut; created_at: Date },
  b: { id: string; ressenti: AvisRessenti; statut: AvisStatut; created_at: Date },
): number {
  const pa = prioritaire(a);
  const pb = prioritaire(b);
  if (pa !== pb) return pa ? -1 : 1;
  const ecart = a.created_at.getTime() - b.created_at.getTime();
  if (ecart !== 0) return pa ? ecart : -ecart;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

const PRIORITAIRE_SQL = Prisma.sql`(a.ressenti::text = 'PAS_CONTENT' AND a.statut::text IN (${Prisma.join(STATUTS_NON_TRAITES)}))`;

export const SQL_TRI = Prisma.sql`ORDER BY ${PRIORITAIRE_SQL} DESC,
  CASE WHEN ${PRIORITAIRE_SQL} THEN a.created_at END ASC,
  a.created_at DESC, a.id`;

// ─── Dates (Africa/Abidjan = UTC, sans heure d'été) ──────────────────────────

const deux = (n: number) => String(n).padStart(2, '0');

/** `02/11` */
export function formatJour(d: Date): string {
  return `${deux(d.getUTCDate())}/${deux(d.getUTCMonth() + 1)}`;
}

/** `08:42` */
export function formatHeure(d: Date): string {
  return `${deux(d.getUTCHours())}:${deux(d.getUTCMinutes())}`;
}

/** `03/11 à 08:42` */
export function formatJourHeure(d: Date): string {
  return `${formatJour(d)} à ${formatHeure(d)}`;
}

/** `02/11/2026 08:42` (export). */
export function formatDateExport(d: Date | null | undefined): string {
  if (!d) return '';
  return `${formatJour(d)}/${d.getUTCFullYear()} ${formatHeure(d)}`;
}

/** Minuit d'aujourd'hui à Abidjan. */
export function debutDuJour(maintenant: Date): Date {
  return new Date(Date.UTC(maintenant.getUTCFullYear(), maintenant.getUTCMonth(), maintenant.getUTCDate()));
}

// ─── Textes ─────────────────────────────────────────────────────────────────

export const SANS_PRENOM = 'Sans prénom';
export const STORE_INCONNU = 'Store inconnu';
export const JE_NE_SAIS_PAS = 'Je ne sais pas';

/** Prénom saisi, sinon prénom du compte, sinon `null`. */
export function prenomAffiche(prenomSaisi: string | null, prenomCompte?: string | null): string | null {
  return prenomSaisi?.trim() || prenomCompte?.trim() || null;
}

export function extrait(texte: string, longueur: number): string {
  const propre = texte.replace(/\s+/g, ' ').trim();
  return propre.length > longueur ? `${propre.slice(0, longueur).trimEnd()}…` : propre;
}

/** Ligne du journal à la réception (phrases mises bout à bout). */
export function texteReception(p: { rapproche: boolean; statut: AvisStatut; accordRappel: boolean }): string {
  const phrases = ['Avis reçu.'];
  phrases.push(p.rapproche ? 'Client rapproché automatiquement.' : 'Client non rapproché.');
  phrases.push(
    p.statut === AvisStatut.A_RAPPELER
      ? `Statut « ${LIBELLE_STATUT.A_RAPPELER} », échéance 24 h.`
      : `Statut « ${LIBELLE_STATUT[p.statut]} ».`,
  );
  if (!p.accordRappel) phrases.push("Pas d'accord de rappel.");
  return phrases.join(' ');
}

export const TEXTE_ALERTE = 'Alerte envoyée au call center et aux administrateurs.';
export const TEXTE_RAPPROCHEMENT = 'Client rapproché automatiquement.';
export const TEXTE_RETARD = 'Échéance dépassée. Alerte envoyée.';
export const TEXTE_SUPPRESSION = 'Avis supprimé.';
/** Message des notifications d'un avis effacé (droit à l'effacement). */
export const TEXTE_NOTIFICATION_EFFACEE = 'Avis supprimé.';

/** Phrase d'une ligne du journal (3.10), composée par le serveur. */
export function texteSuivi(s: {
  type: AvisSuiviType;
  resultat: AvisResultat | null;
  note: string | null;
  statut_apres: AvisStatut | null;
  solution: AvisSolution | null;
  meta: unknown;
}): string {
  const meta = (s.meta && typeof s.meta === 'object' ? s.meta : {}) as Record<string, unknown>;
  const avecNote = (debut: string) => (s.note ? `${debut} ${s.note}` : debut);
  const resultat = s.resultat ? LIBELLE_RESULTAT[s.resultat] : '';
  switch (s.type) {
    case AvisSuiviType.APPEL:
      return avecNote(`${LIBELLE_ACTION.APPEL} · ${resultat}.`);
    case AvisSuiviType.WHATSAPP:
      return avecNote(`${LIBELLE_ACTION.WHATSAPP} · ${resultat}.`);
    case AvisSuiviType.NOTE:
      return avecNote(`${LIBELLE_ACTION.NOTE}.`);
    case AvisSuiviType.STATUT: {
      const statut = s.statut_apres ? `Statut « ${LIBELLE_STATUT[s.statut_apres]} ».` : 'Statut modifié.';
      return s.solution ? `${statut} Solution : ${LIBELLE_SOLUTION[s.solution]}.` : statut;
    }
    case AvisSuiviType.COMMANDE:
      return typeof meta.reference === 'string' ? `Commande ${meta.reference} cochée.` : 'Commande décochée.';
    case AvisSuiviType.AGENT:
      return typeof meta.agent === 'string' ? `Agent : ${meta.agent}.` : 'Agent retiré.';
    case AvisSuiviType.INCIDENT:
      return `Incident ouvert : ticket ${typeof meta.code === 'string' ? meta.code : ''}.`;
    case AvisSuiviType.SUPPRESSION:
      return TEXTE_SUPPRESSION;
    case AvisSuiviType.SYSTEME:
    default:
      return s.note ?? '';
  }
}

/** Sujet du ticket ouvert par « Créer un incident ». */
export function sujetTicket(a: { created_at: Date; ressenti: AvisRessenti }, store: string | null): string {
  return `Avis du ${formatJour(a.created_at)} · ${LIBELLE_RESSENTI[a.ressenti]} · ${store ?? STORE_INCONNU}`;
}

/** Premier message (interne) du ticket. */
export function messageTicket(
  a: { created_at: Date; ressenti: AvisRessenti; canal: AvisCanal; commentaire: string },
  store: string | null,
): string {
  return (
    `Avis du ${formatJour(a.created_at)} · ${formatHeure(a.created_at)} ` +
    `(${LIBELLE_RESSENTI[a.ressenti]}, ${LIBELLE_CANAL_ECRAN[a.canal]}, ${store ?? STORE_INCONNU}) : ${a.commentaire}`
  );
}

// ─── Export CSV ─────────────────────────────────────────────────────────────

export const ENTETES_EXPORT = [
  'Reçu le',
  'Ressenti',
  'Prénom',
  'Téléphone',
  'Client rapproché',
  'Store',
  'Canal',
  'Commentaire',
  'Accord de rappel',
  'Source',
  'Statut',
  'Échéance',
  'Solution',
  'Agent',
  'Commande',
  'Ticket',
  'Résolu le',
];

/**
 * Une cellule : une formule possible (`=`, `+`, `-`, `@`, tabulation, retour
 * chariot en tête) est neutralisée par une apostrophe, puis `;`, guillemets et
 * retours à la ligne sont échappés.
 */
export function celluleCsv(valeur: string | null | undefined): string {
  let v = valeur ?? '';
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return /[";\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** Point-virgule et BOM, comme les exports du CRM : Excel en français l'ouvre sans assistant. */
export function versCsv(entetes: string[], rangees: string[][]): Buffer {
  const texte = [entetes, ...rangees].map((r) => r.map((c) => celluleCsv(c)).join(';')).join('\r\n');
  return Buffer.from(`﻿${texte}`, 'utf8');
}
