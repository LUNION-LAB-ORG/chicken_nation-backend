/**
 * INCIDENTS SUR COMMANDE (11/11) : règles pures, testées par
 * `incident.rules.spec.ts`. Contrat : `.banc-test-crm/incidents/contrat-incidents.md`.
 *
 * Un incident est le dossier interne de traitement d'un problème sur UNE
 * commande. Il relie le CRM, les tickets (la conversation avec le client) et
 * les avis (retour privé du site, note après commande).
 *
 * Ouvert → En cours → Résolu → Clôturé. Résoudre demande la cause, l'action
 * corrective et le geste ; clôturer, le recontact du client.
 */
import {
  AvisSolution,
  IncidentGeste,
  IncidentGravite,
  IncidentOrigine,
  IncidentPole,
  IncidentRecontact,
  IncidentStatut,
  IncidentSuiviType,
  UserRole,
  UserType,
} from '@prisma/client';
import {
  ROLES_LECTURE_INCIDENT,
  ROLES_RESTAURANT_INCIDENT,
  ROLES_SIEGE_INCIDENT,
  ROLES_SIGNALEMENT_INCIDENT,
} from 'src/modules/auth/constantes/roles-incidents';

const HEURE = 3_600_000;
const JOUR = 24 * HEURE;

// ─── Bornes ──────────────────────────────────────────────────────────────────

export const DESCRIPTION_MIN = 5;
export const DESCRIPTION_MAX = 2000;
export const TEXTE_MIN = 3;
export const TEXTE_MAX = 1000;
export const NOTE_MAX = 2000;
export const MOTIF_MAX = 500;
export const NOM_CATEGORIE_MAX = 80;
export const DELAI_MIN_HEURES = 1;
export const DELAI_MAX_HEURES = 720;
/** Extrait de la description sur une carte ou une ligne. */
export const EXTRAIT = 120;
/** Cartes par colonne du tableau. */
export const CARTES_PAR_COLONNE = 50;
/** La colonne « Clôturé » ne garde que les derniers jours. */
export const JOURS_CLOTURES_AU_TABLEAU = 7;
export const EXPORT_MAX = 5000;
/** Lignes lues au plus pour le tableau de bord. */
export const STATS_MAX = 20000;
/** Recherche d'une commande à signaler : fenêtre et nombre de réponses. */
export const JOURS_RECHERCHE_COMMANDE = 60;
export const COMMANDES_PROPOSEES = 8;
/** Étiquettes des listes de commandes. */
export const OUVERTS_MAX = 500;
export const PERIODE_MAX_JOURS = 366;

// ─── Messages ────────────────────────────────────────────────────────────────

export const MESSAGE_INTROUVABLE = 'Incident introuvable.';
export const MESSAGE_CONFLIT = "L'incident a changé entre-temps. Rechargez la fiche.";
export const MESSAGE_COMMANDE = 'Commande introuvable.';
export const MESSAGE_COMMANDE_AUTRE = "Cette commande n'est pas celle de votre restaurant.";
export const MESSAGE_CATEGORIE = "Cette catégorie n'existe plus. Choisissez-en une autre.";
export const MESSAGE_DESCRIPTION = `Décrivez le problème (${DESCRIPTION_MIN} caractères au moins).`;
export const MESSAGE_DESCRIPTION_LONGUE = 'La description ne doit pas dépasser 2 000 caractères.';
export const MESSAGE_ORIGINE = "Indiquez l'origine du signalement.";
export const MESSAGE_DOUBLON = 'Un incident est déjà ouvert pour cette commande et cette catégorie.';
export const MESSAGE_LIEN = "Ce signalement ne correspond pas à la commande choisie.";
export const MESSAGE_NOTE_DEJA = 'Cette note a déjà son incident.';
export const MESSAGE_AVIS_DEJA = 'Cet avis a déjà son incident.';
export const MESSAGE_DROIT = "Vous ne pouvez pas traiter cet incident.";
export const MESSAGE_LECTURE = "Cet incident n'est pas celui de votre restaurant.";
export const MESSAGE_STATUT = "Ce geste n'est plus possible : l'incident a avancé.";
export const MESSAGE_CAUSE = 'Indiquez la cause.';
export const MESSAGE_ACTION = "Indiquez l'action corrective.";
export const MESSAGE_TEXTE_LONG = 'Ce texte ne doit pas dépasser 1 000 caractères.';
export const MESSAGE_GESTE = 'Choisissez le geste pour le client.';
export const MESSAGE_BON_MONTANT = 'Choisissez un montant du barème.';
export const MESSAGE_BON_INTERDIT = 'Le bon de réduction est décidé par le call center.';
export const MESSAGE_BON_SANS_OBJET = "Cet incident n'a pas de bon à créer.";
export const MESSAGE_BON_EN_COURS = 'Le bon est en cours de création.';
export const MESSAGE_BON_ECHEC = "Le bon n'a pas pu être créé. Réessayez depuis la fiche.";
export const MESSAGE_BON_ABSENT = "Cet incident n'a pas de bon.";
export const MESSAGE_SMS_RECENT = 'Un message vient de partir. Patientez deux minutes.';
export const MESSAGE_SMS_ECHEC = "Le SMS n'est pas parti. Dictez le code au client.";
export const MESSAGE_AVIS_SIEGE = "Un avis du site se traite au call center.";
export const MESSAGE_AVIS_COMMANDE = "Cochez d'abord la commande concernée sur l'avis.";
export const MESSAGE_REACTION = 'Notez la réaction du client.';
export const MESSAGE_RECONTACT = 'Indiquez si le client a été informé.';
export const MESSAGE_MOTIF = 'Indiquez pourquoi vous rouvrez.';
export const MESSAGE_NOTE = 'Écrivez la note.';
export const MESSAGE_NOTE_LONGUE = 'La note ne doit pas dépasser 2 000 caractères.';
export const MESSAGE_AGENT = 'Cette personne ne traite pas les incidents.';
export const MESSAGE_NOM_CATEGORIE = 'Donnez un nom à la catégorie.';
export const MESSAGE_NOM_PRIS = 'Ce nom est déjà utilisé.';
export const MESSAGE_DELAI = 'Le délai va de 1 à 720 heures.';
export const MESSAGE_BAREME = 'Les montants vont de 100 à 100 000 F.';
export const MESSAGE_VALIDITE = 'La validité va de 1 à 365 jours.';
export const MESSAGE_PERIODE = 'La période ne doit pas dépasser un an.';

// ─── Mots ────────────────────────────────────────────────────────────────────

export const LIBELLE_STATUT: Record<IncidentStatut, string> = {
  OUVERT: 'Ouvert',
  EN_COURS: 'En cours',
  RESOLU: 'Résolu',
  CLOTURE: 'Clôturé',
};

export const LIBELLE_GRAVITE: Record<IncidentGravite, string> = {
  FAIBLE: 'Faible',
  MOYENNE: 'Moyenne',
  HAUTE: 'Haute',
};

export const LIBELLE_ORIGINE: Record<IncidentOrigine, string> = {
  APPEL: 'Appel',
  WHATSAPP: 'WhatsApp',
  SUR_PLACE: 'Sur place',
  CONSTAT_INTERNE: 'Constat interne',
  TICKET: 'Ticket',
  AVIS: 'Avis du site',
  NOTE: 'Note après commande',
  RAPPEL: 'Rappel du lendemain',
};

export const LIBELLE_POLE: Record<IncidentPole, string> = {
  RESTAURANT: 'Restaurant',
  LIVRAISON: 'Livraison',
  CALL_CENTER: 'Call center',
};

export const LIBELLE_GESTE: Record<IncidentGeste, string> = {
  AUCUN: 'Aucun geste',
  EXCUSES: 'Excuses',
  BON: 'Bon de réduction',
  REMPLACEMENT: 'Remplacement',
  REMBOURSEMENT: 'Remboursement',
};

export const LIBELLE_RECONTACT: Record<IncidentRecontact, string> = {
  INFORME: 'Client informé',
  INJOIGNABLE: 'Client injoignable',
  SANS_RECONTACT: 'Sans recontact',
};

/** Origines qu'un agent choisit ; les autres viennent du lien (ticket, avis, note). */
export const ORIGINES_SAISIES: IncidentOrigine[] = [
  IncidentOrigine.APPEL,
  IncidentOrigine.WHATSAPP,
  IncidentOrigine.SUR_PLACE,
  IncidentOrigine.CONSTAT_INTERNE,
];

export const STATUTS_NON_CLOTURES: IncidentStatut[] = [
  IncidentStatut.OUVERT,
  IncidentStatut.EN_COURS,
  IncidentStatut.RESOLU,
];

export const STATUTS_A_RESOUDRE: IncidentStatut[] = [IncidentStatut.OUVERT, IncidentStatut.EN_COURS];

export const STATUTS_REOUVRABLES: IncidentStatut[] = [IncidentStatut.RESOLU, IncidentStatut.CLOTURE];

// ─── Qui fait quoi ───────────────────────────────────────────────────────────

export interface Acteur {
  id: string;
  role: UserRole;
  type: UserType;
  restaurant_id: string | null;
}

const dans = (liste: readonly UserRole[], role: UserRole) => liste.includes(role);

/** Compte de point de vente : ne voit et ne touche que son restaurant. */
export const estCompteRestaurant = (u: Pick<Acteur, 'type'>) => u.type === UserType.RESTAURANT;

/** Administrateur ou call center : tout le réseau. */
export const estSiegeIncident = (u: Acteur) => dans(ROLES_SIEGE_INCIDENT, u.role) && !estCompteRestaurant(u);

const UUID_IMPOSSIBLE = '00000000-0000-0000-0000-000000000000';

/**
 * Restaurant auquel les lectures de ce compte sont bornées : le sien pour un
 * compte de point de vente (jamais un paramètre), celui du filtre sinon.
 * Sans restaurant rattaché : un identifiant impossible, donc rien.
 */
export function porteeRestaurant(u: Acteur, filtre?: string | null): string | undefined {
  if (estCompteRestaurant(u)) return u.restaurant_id ?? UUID_IMPOSSIBLE;
  return filtre || undefined;
}

export function peutLire(u: Acteur): boolean {
  return dans(ROLES_LECTURE_INCIDENT, u.role);
}

export function peutVoirIncident(u: Acteur, i: { restaurant_id: string }): boolean {
  if (!peutLire(u)) return false;
  return !estCompteRestaurant(u) || (!!u.restaurant_id && u.restaurant_id === i.restaurant_id);
}

/** Signaler sur une commande de ce restaurant. */
export function peutSignaler(u: Acteur, restaurantId: string): boolean {
  if (!dans(ROLES_SIGNALEMENT_INCIDENT, u.role)) return false;
  return !estCompteRestaurant(u) || (!!u.restaurant_id && u.restaurant_id === restaurantId);
}

/**
 * Traiter : le siège partout ; manager et assistant, les incidents de LEUR
 * restaurant confiés au restaurant (un retard de livraison ne se règle pas
 * en cuisine).
 */
export function peutTraiterIncident(u: Acteur, i: { restaurant_id: string; pole: IncidentPole }): boolean {
  if (estSiegeIncident(u)) return true;
  return (
    dans(ROLES_RESTAURANT_INCIDENT, u.role) &&
    estCompteRestaurant(u) &&
    !!u.restaurant_id &&
    u.restaurant_id === i.restaurant_id &&
    i.pole === IncidentPole.RESTAURANT
  );
}

export interface DroitsIncident {
  /** Ce compte traite cet incident (quel que soit son statut) : il lit le code du bon et peut le renvoyer. */
  traiter: boolean;
  /** Ajouter une note au journal. */
  noter: boolean;
  /** « Prendre en charge » : En cours, à mon nom. */
  prendre: boolean;
  /** Changer le responsable ou l'agent (siège). */
  assigner: boolean;
  resoudre: boolean;
  /** Proposer le bon de réduction parmi les gestes. */
  bon: boolean;
  cloturer: boolean;
  rouvrir: boolean;
}

export function droitsIncident(
  u: Acteur,
  i: { restaurant_id: string; pole: IncidentPole; statut: IncidentStatut; agent_id?: string | null },
  reglages: { bon_restaurant: boolean },
): DroitsIncident {
  const voit = peutVoirIncident(u, i);
  const traite = voit && peutTraiterIncident(u, i);
  const siege = estSiegeIncident(u);
  const aResoudre = STATUTS_A_RESOUDRE.includes(i.statut);
  return {
    traiter: traite,
    noter: voit && dans(ROLES_SIGNALEMENT_INCIDENT, u.role),
    prendre: traite && aResoudre && i.agent_id !== u.id,
    assigner: voit && siege && aResoudre,
    resoudre: traite && aResoudre,
    bon: traite && aResoudre && (siege || reglages.bon_restaurant),
    cloturer: traite && i.statut === IncidentStatut.RESOLU,
    rouvrir: voit && siege && STATUTS_REOUVRABLES.includes(i.statut),
  };
}

// ─── Textes saisis ───────────────────────────────────────────────────────────

/** Espaces de bord retirés, lignes vides en trop resserrées. */
export function nettoyerTexte(brut: unknown): string {
  if (typeof brut !== 'string') return '';
  return brut
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Texte nettoyé, ou le message du refus. */
export type Saisie = { texte: string } | { refus: string };

export function saisirDescription(brut: unknown): Saisie {
  const texte = nettoyerTexte(brut);
  if (texte.length < DESCRIPTION_MIN) return { refus: MESSAGE_DESCRIPTION };
  if (texte.length > DESCRIPTION_MAX) return { refus: MESSAGE_DESCRIPTION_LONGUE };
  return { texte };
}

function saisirCourt(brut: unknown, vide: string, max = TEXTE_MAX, long = MESSAGE_TEXTE_LONG): Saisie {
  const texte = nettoyerTexte(brut);
  if (texte.length < TEXTE_MIN) return { refus: vide };
  if (texte.length > max) return { refus: long };
  return { texte };
}

export const saisirCause = (brut: unknown) => saisirCourt(brut, MESSAGE_CAUSE);
export const saisirAction = (brut: unknown) => saisirCourt(brut, MESSAGE_ACTION);
export const saisirReaction = (brut: unknown) => saisirCourt(brut, MESSAGE_REACTION);
export const saisirMotif = (brut: unknown) => saisirCourt(brut, MESSAGE_MOTIF, MOTIF_MAX);

export function saisirNote(brut: unknown): Saisie {
  const texte = nettoyerTexte(brut);
  if (texte.length < 1) return { refus: MESSAGE_NOTE };
  if (texte.length > NOTE_MAX) return { refus: MESSAGE_NOTE_LONGUE };
  return { texte };
}

export function extrait(texte: string, longueur = EXTRAIT): string {
  const plat = texte.replace(/\s+/g, ' ').trim();
  return plat.length <= longueur ? plat : `${plat.slice(0, longueur).trimEnd()}…`;
}

// ─── Origine ─────────────────────────────────────────────────────────────────

export type LienOrigine = 'ticket' | 'avis' | 'note' | null;

/**
 * L'origine suit le lien quand il y en a un (un incident ouvert depuis un
 * ticket vient du ticket, quoi que dise le formulaire) ; sinon l'agent la
 * choisit parmi les origines saisies.
 */
export function origineRetenue(lien: LienOrigine, saisie: IncidentOrigine | null | undefined): IncidentOrigine | null {
  if (lien === 'ticket') return IncidentOrigine.TICKET;
  if (lien === 'avis') return IncidentOrigine.AVIS;
  if (lien === 'note') return IncidentOrigine.NOTE;
  return saisie && ORIGINES_SAISIES.includes(saisie) ? saisie : null;
}

// ─── Code ────────────────────────────────────────────────────────────────────

const deux = (n: number) => String(n).padStart(2, '0');

/** « INC-261111- » : le jour d'Abidjan, qui est celui du temps universel. */
export function prefixeCode(jour: Date): string {
  return `INC-${deux(jour.getUTCFullYear() % 100)}${deux(jour.getUTCMonth() + 1)}${deux(jour.getUTCDate())}-`;
}

/** Numéro qui suit le dernier code du jour (« INC-261111-007 » → 8) ; 1 sans code. */
export function numeroSuivant(dernierCode: string | null | undefined): number {
  const n = dernierCode ? parseInt(dernierCode.split('-').pop() ?? '', 10) : 0;
  return (Number.isFinite(n) && n > 0 ? n : 0) + 1;
}

export function codeIncident(jour: Date, numero: number): string {
  return `${prefixeCode(jour)}${String(numero).padStart(3, '0')}`;
}

// ─── Délai ───────────────────────────────────────────────────────────────────

export function echeance(creation: Date, delaiHeures: number): Date {
  return new Date(creation.getTime() + delaiHeures * HEURE);
}

export function enRetard(i: { statut: IncidentStatut; echeance_at: Date }, maintenant: Date): boolean {
  return STATUTS_A_RESOUDRE.includes(i.statut) && i.echeance_at.getTime() < maintenant.getTime();
}

const RANG_GRAVITE: Record<IncidentGravite, number> = { HAUTE: 0, MOYENNE: 1, FAIBLE: 2 };

/** Colonnes « Ouvert » et « En cours » : en retard d'abord, puis le plus grave, puis le plus ancien. */
export function comparerATraiter(
  a: { statut: IncidentStatut; gravite: IncidentGravite; echeance_at: Date; created_at: Date },
  b: { statut: IncidentStatut; gravite: IncidentGravite; echeance_at: Date; created_at: Date },
  maintenant: Date,
): number {
  const retard = Number(enRetard(b, maintenant)) - Number(enRetard(a, maintenant));
  if (retard !== 0) return retard;
  const gravite = RANG_GRAVITE[a.gravite] - RANG_GRAVITE[b.gravite];
  if (gravite !== 0) return gravite;
  return a.created_at.getTime() - b.created_at.getTime();
}

/** Début de la fenêtre de la colonne « Clôturé ». */
export function debutCloturesAuTableau(maintenant: Date): Date {
  return new Date(maintenant.getTime() - JOURS_CLOTURES_AU_TABLEAU * JOUR);
}

// ─── Bon de réduction ────────────────────────────────────────────────────────

export const CLE_BON_FAIBLE = 'incident.bon_faible';
export const CLE_BON_MOYENNE = 'incident.bon_moyenne';
export const CLE_BON_HAUTE = 'incident.bon_haute';
export const CLE_BON_VALIDITE = 'incident.bon_validite_jours';
export const CLE_BON_RESTAURANT = 'incident.bon_restaurant';

export type Bareme = Record<IncidentGravite, number>;

export interface ReglagesIncident {
  bareme: Bareme;
  validite_jours: number;
  /** Manager et assistant peuvent offrir un bon (au barème) pour un incident de leur restaurant. */
  bon_restaurant: boolean;
}

export const REGLAGES_DEFAUT: ReglagesIncident = {
  bareme: { FAIBLE: 1000, MOYENNE: 2000, HAUTE: 3000 },
  validite_jours: 30,
  bon_restaurant: true,
};

export const BON_MIN = 100;
export const BON_MAX = 100_000;
export const VALIDITE_MIN = 1;
export const VALIDITE_MAX = 365;

const entier = (brut: string | null | undefined, min: number, max: number, defaut: number): number => {
  const n = brut == null || brut.trim() === '' ? NaN : Number(brut);
  return Number.isInteger(n) && n >= min && n <= max ? n : defaut;
};

/** Réglages lus dans `settings` ; toute valeur absente ou hors bornes reprend le défaut. */
export function lireReglages(brut: Record<string, string | null | undefined>): ReglagesIncident {
  const d = REGLAGES_DEFAUT;
  const restaurant = brut[CLE_BON_RESTAURANT]?.trim().toLowerCase();
  return {
    bareme: {
      FAIBLE: entier(brut[CLE_BON_FAIBLE], BON_MIN, BON_MAX, d.bareme.FAIBLE),
      MOYENNE: entier(brut[CLE_BON_MOYENNE], BON_MIN, BON_MAX, d.bareme.MOYENNE),
      HAUTE: entier(brut[CLE_BON_HAUTE], BON_MIN, BON_MAX, d.bareme.HAUTE),
    },
    validite_jours: entier(brut[CLE_BON_VALIDITE], VALIDITE_MIN, VALIDITE_MAX, d.validite_jours),
    bon_restaurant: restaurant === undefined || restaurant === '' ? d.bon_restaurant : restaurant === 'true',
  };
}

export const montantValide = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= BON_MIN && n <= BON_MAX;

export const validiteValide = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= VALIDITE_MIN && n <= VALIDITE_MAX;

/** Montants proposés : ceux du barème, sans doublon, du plus petit au plus grand. */
export function montantsBon(bareme: Bareme): number[] {
  return [...new Set([bareme.FAIBLE, bareme.MOYENNE, bareme.HAUTE])].sort((a, b) => a - b);
}

export function bonSuggere(gravite: IncidentGravite, bareme: Bareme): number {
  return bareme[gravite];
}

export function expirationBon(maintenant: Date, validiteJours: number): Date {
  return new Date(maintenant.getTime() + validiteJours * JOUR);
}

/** « 2 000 F », avec des espaces ordinaires (un SMS n'aime pas les espaces fines). */
export function montantLisible(n: number): string {
  return `${String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} F`;
}

/** « 11/12/2026 » */
export function formatJour(d: Date): string {
  return `${deux(d.getUTCDate())}/${deux(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}

/** « 11/12 à 08:42 » */
export function formatJourHeure(d: Date): string {
  return `${deux(d.getUTCDate())}/${deux(d.getUTCMonth() + 1)} à ${deux(d.getUTCHours())}:${deux(d.getUTCMinutes())}`;
}

/**
 * SMS qui porte le code du bon, en un seul message (160 caractères). Sans
 * caractère hors de l'alphabet des SMS (ni « ê », ni « ç », ni guillemets
 * français) : un seul suffit à doubler le nombre de messages facturés.
 */
export function texteSmsBon(p: { montant: number; code: string; expire: Date }): string {
  return (
    `Chicken Nation : nos excuses pour votre commande. Bon de ${montantLisible(p.montant)} offert, ` +
    `code ${p.code}, valable jusqu'au ${formatJour(p.expire)}. Donnez-le à votre prochaine commande.`
  );
}

// ─── Résolution et clôture ───────────────────────────────────────────────────

export interface Resolution {
  cause: string;
  action: string;
  geste: IncidentGeste;
  /** Seulement pour un bon. */
  bon_montant: number | null;
}

/**
 * Ce qu'il faut pour résoudre : cause, action corrective et geste. Un bon
 * prend un montant du barème, et seulement si ce compte peut en offrir. Un
 * incident rouvert qui a déjà son bon le garde, avec son montant : il n'y a
 * jamais deux bons pour un incident.
 */
export function verifierResolution(
  p: { cause: unknown; action: unknown; geste: IncidentGeste | null | undefined; bon_montant?: number | null },
  contexte: { peutOffrirBon: boolean; bareme: Bareme; bonExistant: number | null },
): Resolution | { refus: string } {
  const cause = saisirCause(p.cause);
  if ('refus' in cause) return cause;
  const action = saisirAction(p.action);
  if ('refus' in action) return action;
  if (!p.geste || !(p.geste in LIBELLE_GESTE)) return { refus: MESSAGE_GESTE };
  // Un bon déjà créé reste acquis au client, quel que soit le geste choisi ensuite.
  if (contexte.bonExistant !== null) {
    return { cause: cause.texte, action: action.texte, geste: p.geste, bon_montant: contexte.bonExistant };
  }
  if (p.geste !== IncidentGeste.BON) return { cause: cause.texte, action: action.texte, geste: p.geste, bon_montant: null };
  if (!contexte.peutOffrirBon) return { refus: MESSAGE_BON_INTERDIT };
  if (typeof p.bon_montant !== 'number' || !montantsBon(contexte.bareme).includes(p.bon_montant)) {
    return { refus: MESSAGE_BON_MONTANT };
  }
  return { cause: cause.texte, action: action.texte, geste: p.geste, bon_montant: p.bon_montant };
}

export interface Cloture {
  recontact: IncidentRecontact;
  reaction: string | null;
}

/** Clôturer : dire si le client a été informé ; sa réaction quand il l'a été. */
export function verifierCloture(p: { recontact: IncidentRecontact | null | undefined; reaction?: unknown }): Cloture | { refus: string } {
  if (!p.recontact || !(p.recontact in LIBELLE_RECONTACT)) return { refus: MESSAGE_RECONTACT };
  const texte = nettoyerTexte(p.reaction);
  if (p.recontact === IncidentRecontact.INFORME) {
    const reaction = saisirReaction(texte);
    if ('refus' in reaction) return reaction;
    return { recontact: p.recontact, reaction: reaction.texte };
  }
  if (texte.length > TEXTE_MAX) return { refus: MESSAGE_TEXTE_LONG };
  return { recontact: p.recontact, reaction: texte || null };
}

/** Solution portée sur l'avis du site quand son incident est clôturé. */
export function solutionAvis(geste: IncidentGeste | null): AvisSolution {
  switch (geste) {
    case IncidentGeste.EXCUSES:
      return AvisSolution.EXCUSES;
    case IncidentGeste.BON:
      return AvisSolution.GESTE_COMMERCIAL;
    case IncidentGeste.REMPLACEMENT:
      return AvisSolution.REMPLACEMENT;
    case IncidentGeste.REMBOURSEMENT:
      return AvisSolution.REMBOURSEMENT;
    default:
      return AvisSolution.AUCUNE;
  }
}

// ─── Journal ─────────────────────────────────────────────────────────────────

export interface LigneSuivi {
  type: IncidentSuiviType;
  note: string | null;
  meta: Record<string, unknown> | null;
  auteur_nom: string | null;
}

const texteDe = (meta: Record<string, unknown> | null, cle: string): string | null => {
  const v = meta?.[cle];
  return typeof v === 'string' && v ? v : null;
};

const SYSTEME = 'Système';

/** Phrase d'une ligne du journal ; la note éventuelle s'affiche dessous. */
export function texteSuivi(s: LigneSuivi): string {
  const qui = s.auteur_nom || SYSTEME;
  const meta = s.meta;
  switch (s.type) {
    case IncidentSuiviType.CREATION: {
      const origine = texteDe(meta, 'origine') as IncidentOrigine | null;
      const source = origine && LIBELLE_ORIGINE[origine] ? ` (${LIBELLE_ORIGINE[origine]})` : '';
      return `Signalé par ${qui}${source}`;
    }
    case IncidentSuiviType.ASSIGNATION: {
      const pole = texteDe(meta, 'pole') as IncidentPole | null;
      const agent = texteDe(meta, 'agent');
      if (meta?.prise === true) return `Pris en charge par ${qui}`;
      const cible = [pole && LIBELLE_POLE[pole] ? LIBELLE_POLE[pole] : null, agent].filter(Boolean).join(', ');
      return cible ? `Confié à : ${cible}, par ${qui}` : `Responsable retiré par ${qui}`;
    }
    case IncidentSuiviType.RESOLUTION: {
      const geste = texteDe(meta, 'geste') as IncidentGeste | null;
      return `Résolu par ${qui}${geste && LIBELLE_GESTE[geste] ? ` : ${LIBELLE_GESTE[geste].toLowerCase()}` : ''}`;
    }
    case IncidentSuiviType.BON: {
      const code = texteDe(meta, 'code');
      const montant = typeof meta?.montant === 'number' ? montantLisible(meta.montant) : null;
      const expire = texteDe(meta, 'expire');
      if (!code) return "Le bon n'a pas pu être créé";
      return `Bon ${code}${montant ? ` de ${montant}` : ''} créé${expire ? `, valable jusqu'au ${expire}` : ''}`;
    }
    case IncidentSuiviType.MESSAGE:
      return meta?.envoye === true ? 'Code du bon envoyé au client par SMS' : "Le SMS du bon n'est pas parti";
    case IncidentSuiviType.CLOTURE: {
      const recontact = texteDe(meta, 'recontact') as IncidentRecontact | null;
      return `Clôturé par ${qui}${recontact && LIBELLE_RECONTACT[recontact] ? ` : ${LIBELLE_RECONTACT[recontact].toLowerCase()}` : ''}`;
    }
    case IncidentSuiviType.REOUVERTURE:
      return `Rouvert par ${qui}`;
    case IncidentSuiviType.RETARD:
      return 'Délai dépassé. Alerte envoyée.';
    case IncidentSuiviType.NOTE:
    default:
      return `Note de ${qui}`;
  }
}

// ─── Recherche ───────────────────────────────────────────────────────────────

/** Texte cherché et chiffres seuls (un numéro se tape avec ou sans espaces). */
export function critereRecherche(brut: unknown): { texte: string; chiffres: string } | null {
  if (typeof brut !== 'string') return null;
  const texte = brut.trim().slice(0, 60);
  if (texte.length < 2) return null;
  const chiffres = texte.replace(/\D/g, '');
  return { texte, chiffres: chiffres.length >= 4 ? chiffres : '' };
}

/** Nom affiché d'un client : prénom et nom, sinon le nom saisi sur la commande. */
export function nomClient(
  client: { first_name?: string | null; last_name?: string | null } | null | undefined,
  nomCommande?: string | null,
): string {
  const nom = [client?.first_name, client?.last_name].map((t) => t?.trim()).filter(Boolean).join(' ');
  return nom || nomCommande?.trim() || 'Client';
}

// ─── Période ─────────────────────────────────────────────────────────────────

/** « 2026-11-11 » → minuit du jour ; null si la date est illisible. */
export function debutJour(iso: string | null | undefined): Date | null {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return null;
  const d = new Date(`${iso.slice(0, 10)}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Bornes d'une période inclusive : `[du 00:00, lendemain de au 00:00[`. */
export function bornesPeriode(du?: string | null, au?: string | null): { debut: Date | null; fin: Date | null } {
  const debut = debutJour(du);
  const dernier = debutJour(au);
  return { debut, fin: dernier ? new Date(dernier.getTime() + JOUR) : null };
}

/** Période du tableau de bord : les 30 derniers jours par défaut, un an au plus. */
export function periodeStats(
  du: string | null | undefined,
  au: string | null | undefined,
  maintenant: Date,
): { debut: Date; fin: Date; du: string; au: string } | { refus: string } {
  const jour = (d: Date) => d.toISOString().slice(0, 10);
  const dernier = debutJour(au) ?? debutJour(jour(maintenant))!;
  const premier = debutJour(du) ?? new Date(dernier.getTime() - 29 * JOUR);
  const [debut, finJour] = premier.getTime() <= dernier.getTime() ? [premier, dernier] : [dernier, premier];
  if ((finJour.getTime() - debut.getTime()) / JOUR > PERIODE_MAX_JOURS) return { refus: MESSAGE_PERIODE };
  return { debut, fin: new Date(finJour.getTime() + JOUR), du: jour(debut), au: jour(finJour) };
}

// ─── Tableau de bord ─────────────────────────────────────────────────────────

export interface LigneStat {
  id: string;
  code: string;
  statut: IncidentStatut;
  gravite: IncidentGravite;
  origine: IncidentOrigine;
  pole: IncidentPole;
  geste: IncidentGeste | null;
  bon_montant: number | null;
  voucher_id: string | null;
  categorie_id: string;
  categorie_nom: string;
  restaurant_id: string;
  restaurant_nom: string;
  created_at: Date;
  resolu_at: Date | null;
  echeance_at: Date;
  cause: string | null;
  action: string | null;
}

export interface Statistiques {
  du: string;
  au: string;
  total: number;
  ouverts: number;
  en_cours: number;
  resolus: number;
  clotures: number;
  en_retard: number;
  /** Création → résolution, en heures (une décimale) ; null sans incident résolu. */
  delai_moyen_heures: number | null;
  /** Part des incidents résolus avant leur échéance ; null sans incident résolu. */
  dans_les_delais_pct: number | null;
  par_categorie: { id: string; nom: string; total: number; ouverts: number }[];
  par_restaurant: { id: string; name: string; total: number; ouverts: number }[];
  par_pole: { pole: IncidentPole; total: number }[];
  par_origine: { origine: IncidentOrigine; total: number }[];
  par_gravite: { gravite: IncidentGravite; total: number }[];
  par_jour: { jour: string; total: number }[];
  gestes: { geste: IncidentGeste; total: number }[];
  bons: { nombre: number; montant: number };
  /** Dernières causes et actions correctives, pour la revue du lundi. */
  corrections: { id: string; code: string; categorie: string; restaurant: string; cause: string; action: string; resolu_at: Date }[];
}

export const CORRECTIONS_AFFICHEES = 10;

const compter = <C extends string>(cles: C[]): Map<C, number> => new Map(cles.map((c) => [c, 0]));

/** Chiffres d'une période, calculés sur les lignes lues (la période porte sur la création). */
export function agregerStatistiques(
  lignes: readonly LigneStat[],
  periode: { debut: Date; fin: Date; du: string; au: string },
  maintenant: Date,
): Statistiques {
  const parStatut = compter(Object.values(IncidentStatut));
  const parPole = compter(Object.values(IncidentPole));
  const parOrigine = compter(Object.values(IncidentOrigine));
  const parGravite = compter(Object.values(IncidentGravite));
  const parGeste = compter(Object.values(IncidentGeste));
  const categories = new Map<string, { id: string; nom: string; total: number; ouverts: number }>();
  const restaurants = new Map<string, { id: string; name: string; total: number; ouverts: number }>();
  const jours = new Map<string, number>();
  for (let t = periode.debut.getTime(); t < periode.fin.getTime(); t += JOUR) {
    jours.set(new Date(t).toISOString().slice(0, 10), 0);
  }

  let retard = 0;
  let resolus = 0;
  let dureeResolution = 0;
  let dansLesDelais = 0;
  let bons = 0;
  let montantBons = 0;

  for (const l of lignes) {
    parStatut.set(l.statut, (parStatut.get(l.statut) ?? 0) + 1);
    parPole.set(l.pole, (parPole.get(l.pole) ?? 0) + 1);
    parOrigine.set(l.origine, (parOrigine.get(l.origine) ?? 0) + 1);
    parGravite.set(l.gravite, (parGravite.get(l.gravite) ?? 0) + 1);
    if (l.geste) parGeste.set(l.geste, (parGeste.get(l.geste) ?? 0) + 1);

    const nonRegle = STATUTS_A_RESOUDRE.includes(l.statut);
    const categorie = categories.get(l.categorie_id) ?? { id: l.categorie_id, nom: l.categorie_nom, total: 0, ouverts: 0 };
    categorie.total++;
    if (nonRegle) categorie.ouverts++;
    categories.set(l.categorie_id, categorie);
    const restaurant = restaurants.get(l.restaurant_id) ?? { id: l.restaurant_id, name: l.restaurant_nom, total: 0, ouverts: 0 };
    restaurant.total++;
    if (nonRegle) restaurant.ouverts++;
    restaurants.set(l.restaurant_id, restaurant);

    const jour = l.created_at.toISOString().slice(0, 10);
    if (jours.has(jour)) jours.set(jour, (jours.get(jour) ?? 0) + 1);

    if (enRetard(l, maintenant)) retard++;
    if (l.resolu_at) {
      resolus++;
      dureeResolution += l.resolu_at.getTime() - l.created_at.getTime();
      if (l.resolu_at.getTime() <= l.echeance_at.getTime()) dansLesDelais++;
    }
    if (l.voucher_id && l.bon_montant) {
      bons++;
      montantBons += l.bon_montant;
    }
  }

  const decroissant = <T extends { total: number }>(a: T, b: T) => b.total - a.total;
  const liste = <C extends string, K extends string>(m: Map<C, number>, cle: K) =>
    [...m.entries()].filter(([, total]) => total > 0).map(([valeur, total]) => ({ [cle]: valeur, total }) as Record<K, C> & { total: number }).sort(decroissant);

  const corrections = lignes
    .filter((l): l is LigneStat & { resolu_at: Date; cause: string; action: string } => !!l.resolu_at && !!l.cause && !!l.action)
    .sort((a, b) => b.resolu_at.getTime() - a.resolu_at.getTime())
    .slice(0, CORRECTIONS_AFFICHEES)
    .map((l) => ({
      id: l.id,
      code: l.code,
      categorie: l.categorie_nom,
      restaurant: l.restaurant_nom,
      cause: l.cause,
      action: l.action,
      resolu_at: l.resolu_at,
    }));

  return {
    du: periode.du,
    au: periode.au,
    total: lignes.length,
    ouverts: parStatut.get(IncidentStatut.OUVERT) ?? 0,
    en_cours: parStatut.get(IncidentStatut.EN_COURS) ?? 0,
    resolus: parStatut.get(IncidentStatut.RESOLU) ?? 0,
    clotures: parStatut.get(IncidentStatut.CLOTURE) ?? 0,
    en_retard: retard,
    delai_moyen_heures: resolus > 0 ? Math.round((dureeResolution / resolus / HEURE) * 10) / 10 : null,
    dans_les_delais_pct: resolus > 0 ? Math.round((dansLesDelais / resolus) * 100) : null,
    par_categorie: [...categories.values()].sort(decroissant),
    par_restaurant: [...restaurants.values()].sort(decroissant),
    par_pole: liste(parPole, 'pole'),
    par_origine: liste(parOrigine, 'origine'),
    par_gravite: liste(parGravite, 'gravite'),
    par_jour: [...jours.entries()].map(([jour, total]) => ({ jour, total })),
    gestes: liste(parGeste, 'geste'),
    bons: { nombre: bons, montant: montantBons },
    corrections,
  };
}

// ─── Catégories ──────────────────────────────────────────────────────────────

export function saisirNomCategorie(brut: unknown): Saisie {
  const texte = typeof brut === 'string' ? brut.replace(/\s+/g, ' ').trim() : '';
  if (texte.length < 2 || texte.length > NOM_CATEGORIE_MAX) return { refus: MESSAGE_NOM_CATEGORIE };
  return { texte };
}

export const delaiValide = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= DELAI_MIN_HEURES && n <= DELAI_MAX_HEURES;

// ─── Export ──────────────────────────────────────────────────────────────────

export const ENTETES_EXPORT = [
  'Incident',
  'Signalé le',
  'Statut',
  'Catégorie',
  'Gravité',
  'Origine',
  'Responsable',
  'Restaurant',
  'Commande',
  'Client',
  'Téléphone',
  'Description',
  'Cause',
  'Action corrective',
  'Geste',
  'Bon (F)',
  'Résolu le',
  'Clôturé le',
  'Recontact',
  'Réaction du client',
];

/** « 11/11/2026 08:42 », vide sans date. */
export function formatDateExport(d: Date | null | undefined): string {
  if (!d) return '';
  return `${formatJour(d)} ${deux(d.getUTCHours())}:${deux(d.getUTCMinutes())}`;
}

/** Cellule CSV : guillemets doublés, et jamais lue comme une formule par un tableur. */
export function celluleCsv(valeur: string | number | null | undefined): string {
  let texte = valeur === null || valeur === undefined ? '' : String(valeur);
  if (/^[=+\-@\t\r]/.test(texte)) texte = `'${texte}`;
  return `"${texte.replace(/"/g, '""')}"`;
}

/** CSV lisible par Excel : séparateur point-virgule, marque d'ordre des octets. */
export function versCsv(entetes: string[], rangees: (string | number | null | undefined)[][]): Buffer {
  const lignes = [entetes, ...rangees].map((r) => r.map(celluleCsv).join(';'));
  return Buffer.from(`﻿${lignes.join('\r\n')}\r\n`, 'utf8');
}
