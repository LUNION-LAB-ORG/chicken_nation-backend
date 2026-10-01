import { OrderStatus, PaiementStatus } from '@prisma/client';
import { cleTelephone } from 'src/modules/crm/crm.rules';
import { etatApresEncaissement } from 'src/modules/paiements/helpers/encaissement.helper';
import {
  BROUILLON_WHERE,
  RELANCABLE_WHERE,
  estBrouillon,
  estPanierAnnuleParClient,
  estRelancable,
} from '../helpers/brouillons.rules';

/**
 * RELANCE DES COMMANDES EN ATTENTE : les règles, sans base ni horloge.
 *
 * `classerBrouillons` est la SEULE source de vérité : la liste, les
 * compteurs, le badge, le bandeau, la tâche d'alerte et chaque geste d'agent
 * passent par elle. Tout lui est donné en paramètre (lectures, heure, réglages,
 * agent) : c'est elle que testent `relance.rules.spec.ts`.
 *
 * Conception : `.banc-test-crm/conception-relance-commandes.md`.
 */

export { BROUILLON_WHERE, RELANCABLE_WHERE, estBrouillon, estPanierAnnuleParClient, estRelancable };

// ---------------------------------------------------------------------------
// Réglages
// ---------------------------------------------------------------------------

/** Clés de la table `Setting`, modifiables par la route `/settings` existante. */
export const RELANCE_SETTINGS = {
  DELAI_MINUTES: 'commandes.relance_delai_minutes',
  DUREE_PRISE_MINUTES: 'commandes.relance_duree_prise_minutes',
  RAPPEL_MINUTES: 'commandes.relance_rappel_minutes',
} as const;

/** Défaut et bornes de chaque réglage. Hors bornes ou illisible : le défaut. */
const BORNES = {
  [RELANCE_SETTINGS.DELAI_MINUTES]: { defaut: 3, min: 1, max: 30 },
  [RELANCE_SETTINGS.DUREE_PRISE_MINUTES]: { defaut: 10, min: 2, max: 60 },
  // 0 : aucun rappel sonore.
  [RELANCE_SETTINGS.RAPPEL_MINUTES]: { defaut: 5, min: 0, max: 60 },
} as const;

/**
 * Âge au delà duquel un brouillon sort de la relance temps réel : rappeler un
 * client pour un repas n'a plus de sens, le CRM prend le relais.
 */
export const FENETRE_HEURES = 3;

/** Une commande payée par le même client dans ce délai avant le panier : doublon probable. */
export const RECENTE_MINUTES = 30;

/** Liste « Ignorées » : depuis combien de temps. */
export const IGNOREES_HEURES = 24;

/** Garde-fou de lecture : au delà, la tâche journalise un avertissement. */
export const MAX_BROUILLONS_LUS = 500;

export interface ReglesRelance {
  delai_minutes: number;
  duree_prise_minutes: number;
  rappel_minutes: number;
  fenetre_heures: number;
  recente_minutes: number;
}

function entierBorne(valeur: string | null | undefined, cle: keyof typeof BORNES): number {
  const { defaut, min, max } = BORNES[cle];
  if (valeur === null || valeur === undefined || String(valeur).trim() === '') return defaut;
  const n = Number(String(valeur).trim());
  if (!Number.isInteger(n) || n < min || n > max) return defaut;
  return n;
}

/** Réglages lus en base (valeurs texte), ramenés à des nombres sûrs. Ne lève jamais. */
export function lireRegles(valeurs: Record<string, string | null | undefined> = {}): ReglesRelance {
  return {
    delai_minutes: entierBorne(valeurs[RELANCE_SETTINGS.DELAI_MINUTES], RELANCE_SETTINGS.DELAI_MINUTES),
    duree_prise_minutes: entierBorne(
      valeurs[RELANCE_SETTINGS.DUREE_PRISE_MINUTES],
      RELANCE_SETTINGS.DUREE_PRISE_MINUTES,
    ),
    rappel_minutes: entierBorne(valeurs[RELANCE_SETTINGS.RAPPEL_MINUTES], RELANCE_SETTINGS.RAPPEL_MINUTES),
    fenetre_heures: FENETRE_HEURES,
    recente_minutes: RECENTE_MINUTES,
  };
}

// ---------------------------------------------------------------------------
// Raisons d'ignorer
// ---------------------------------------------------------------------------

/**
 * Pourquoi l'alerte ne demande pas d'appel. Distinctes des raisons de
 * non-commande du CRM, qui disent pourquoi le client ne commande pas.
 */
export const RAISONS_IGNORER = [
  'CLIENT_INJOIGNABLE',
  'NE_VEUT_PLUS',
  'DEJA_COMMANDE',
  'DOUBLON',
  'TEST_INTERNE',
  'AUTRE',
] as const;

export type RaisonIgnorer = (typeof RAISONS_IGNORER)[number];

export const LIBELLES_RAISON: Record<RaisonIgnorer, string> = {
  CLIENT_INJOIGNABLE: 'Client injoignable',
  NE_VEUT_PLUS: 'Le client ne souhaite plus commander',
  DEJA_COMMANDE: 'Le client a déjà commandé',
  DOUBLON: 'Doublon',
  TEST_INTERNE: 'Test interne',
  AUTRE: 'Autre',
};

export const libelleRaison = (code: string | null | undefined): string =>
  (code && LIBELLES_RAISON[code as RaisonIgnorer]) || LIBELLES_RAISON.AUTRE;

// ---------------------------------------------------------------------------
// Motifs de sortie
// ---------------------------------------------------------------------------

/**
 * Pourquoi une commande n'est plus à relancer. Les cinq premiers se lisent
 * sur la commande (elle n'est plus un brouillon), les deux suivants sont les
 * exclusions automatiques, le dernier est l'âge.
 */
export type MotifSortie =
  | 'REPRISE'
  | 'PAYEE'
  | 'CONFIRMEE'
  | 'ANNULEE'
  | 'SUPPRIMEE'
  | 'PAIEMENT_A_CONFIRMER'
  | 'RECOMMANDE'
  | 'HORS_FENETRE';

/** Ce qu'il faut lire d'une commande pour dire pourquoi elle n'est plus un brouillon. */
export interface CommandeSortie {
  auto?: boolean | null;
  status?: OrderStatus | string | null;
  paied?: boolean | null;
  entity_status?: string | null;
}

/**
 * Motif d'une commande qui n'est plus un brouillon, dans l'ordre de la
 * conception (1.7). `null` : c'est encore un brouillon, ou rien ne l'explique
 * (paiement au restaurant annoncé dès la création, par exemple).
 */
export function motifSortie(commande: CommandeSortie): MotifSortie | null {
  if (commande.auto === false) return 'REPRISE';
  if (commande.entity_status === 'DELETED') return 'SUPPRIMEE';
  if (commande.status === OrderStatus.CANCELLED) return 'ANNULEE';
  if (commande.paied === true) return 'PAYEE';
  // Sortie de l'attente sans paiement ni reprise : le personnel l'a acceptée
  // (back office). Ne jamais dire « a payé » pour un panier resté impayé.
  if (commande.status && commande.status !== OrderStatus.PENDING) return 'CONFIRMEE';
  return null;
}

/** Libellé prêt à afficher d'un motif de sortie. */
export function libelleMotif(
  motif: MotifSortie,
  detail: { reference?: string | null; auteur?: string | null; fenetre_heures?: number } = {},
): string {
  switch (motif) {
    case 'REPRISE':
      return detail.auteur ? `Reprise au téléphone par ${detail.auteur}` : 'Reprise au téléphone';
    case 'PAYEE':
      return "A payé dans l'application";
    case 'CONFIRMEE':
      return "Confirmée par l'équipe";
    case 'ANNULEE':
      return 'Annulée';
    case 'SUPPRIMEE':
      return 'Supprimée';
    case 'PAIEMENT_A_CONFIRMER':
      return 'Paiement reçu, confirmation en cours';
    case 'RECOMMANDE':
      return detail.reference ? `A recommandé : ${detail.reference}` : 'A recommandé';
    case 'HORS_FENETRE':
      return `Plus de ${detail.fenetre_heures ?? FENETRE_HEURES} h : suivi par le CRM`;
  }
}

const minusculeInitiale = (texte: string) => texte.charAt(0).toLowerCase() + texte.slice(1);

/** Message d'erreur (409) d'un geste sur une commande qui n'est plus à relancer. */
export function messageSortie(
  motif: MotifSortie | null,
  detail: { reference?: string | null; auteur?: string | null; fenetre_heures?: number } = {},
): string {
  if (motif === 'HORS_FENETRE') {
    return `Cette commande a plus de ${detail.fenetre_heures ?? FENETRE_HEURES} h : elle n'est plus suivie ici.`;
  }
  if (motif === 'RECOMMANDE') {
    return detail.reference
      ? `Cette commande n'est plus à relancer : a recommandé (${detail.reference}).`
      : "Cette commande n'est plus à relancer : a recommandé.";
  }
  if (!motif) return "Cette commande n'est plus à relancer.";
  return `Cette commande n'est plus à relancer : ${minusculeInitiale(libelleMotif(motif, detail))}.`;
}

// ---------------------------------------------------------------------------
// Lectures attendues par le classement
// ---------------------------------------------------------------------------

export interface PaiementLu {
  status: PaiementStatus | string;
  amount?: number | null;
  total?: number | null;
  created_at: Date;
}

export interface RelanceLue {
  alerte_le: Date | null;
  pris_par_id: string | null;
  pris_par?: { id: string; fullname: string | null } | null;
  pris_le: Date | null;
  prise_expire_le: Date | null;
  ignore_le: Date | null;
}

export interface BrouillonLu {
  id: string;
  reference: string;
  created_at: Date;
  customer_id: string | null;
  restaurant_id: string;
  fullname: string | null;
  phone: string | null;
  type: string;
  amount: number;
  customer?: { phone?: string | null; first_name?: string | null; last_name?: string | null } | null;
  restaurant?: { id: string; name: string } | null;
  paiements?: PaiementLu[];
  relance?: RelanceLue | null;
  /**
   * État de la commande : distingue un panier annulé par le client
   * (`estPanierAnnuleParClient`) d'un brouillon encore en attente. Absents :
   * brouillon en attente.
   */
  auto?: boolean | null;
  status?: OrderStatus | string | null;
  paied?: boolean | null;
  payment_method?: string | null;
  entity_status?: string | null;
  cancelled_by?: string | null;
  cancelled_at?: Date | null;
}

export interface CommandeEffectiveLue {
  id: string;
  reference: string;
  created_at: Date;
  /** Une commande annulée ne contredit aucun panier (la lecture les écarte déjà). */
  status?: OrderStatus | string | null;
  customer_id: string | null;
  phone: string | null;
  customer?: { phone?: string | null } | null;
}

// ---------------------------------------------------------------------------
// Résultat
// ---------------------------------------------------------------------------

export type EtatGroupe = 'A_RELANCER' | 'PRIS' | 'EN_COURS';

export interface PriseGroupe {
  par_id: string;
  par_nom: string;
  le: Date | null;
  expire_le: Date;
  par_moi: boolean;
}

export interface SignauxGroupe {
  /** Un paiement refusé sur l'un des paniers : l'appel le plus utile. */
  paiement_refuse: boolean;
  /** Paiement reçu sans couvrir le panier : « Paiement partiel : X F reçus sur Y F ». */
  paiement_partiel: { reference: string; recu: number; montant: number } | null;
  /** Le même client a payé une commande peu avant : doublon probable. */
  commande_recente: { reference: string; created_at: Date } | null;
  /**
   * Le client a annulé lui-même dans l'application : date d'annulation de la
   * tête si c'est elle, sinon du panier annulé le plus récent du groupe.
   */
  annulee_par_client: { le: Date } | null;
}

export interface GroupeClasse {
  /** Identifiant de la tête : stable tant que le client ne crée pas de nouveau panier. */
  cle: string;
  etat: EtatGroupe;
  restaurant_id: string;
  /** Brouillon non ignoré le plus récent. */
  tete: BrouillonLu;
  /** Autres brouillons non ignorés, plus récents d'abord. */
  autres: BrouillonLu[];
  /** Brouillons non ignorés du groupe, triés (ordre fixe des écritures). */
  ids: string[];
  /** Brouillons ignorés du même client, triés. */
  ignores: string[];
  prise: PriseGroupe | null;
  /** EN_COURS : passage en A_RELANCER ; PRIS : fin de la prise ; sinon null. */
  echeance: Date | null;
  signaux: SignauxGroupe;
}

/** Groupe dont tous les brouillons sont ignorés : hors alertes. */
export interface GroupeIgnore {
  cle: string;
  restaurant_id: string;
  ignores: string[];
}

export interface Exclusion {
  motif: 'PAIEMENT_A_CONFIRMER' | 'RECOMMANDE';
  /** RECOMMANDE : référence de la commande payée ensuite. */
  reference?: string;
}

export interface Classement {
  /** A_RELANCER, PRIS et EN_COURS, triés pour l'écran. */
  groupes: GroupeClasse[];
  groupesIgnores: GroupeIgnore[];
  /** Brouillons écartés avant regroupement (1.5), par identifiant de commande. */
  exclus: Map<string, Exclusion>;
  /** Prochain changement d'état sans aucune écriture (passage du délai, fin de prise). */
  prochaineEcheance: Date | null;
}

// ---------------------------------------------------------------------------
// Petits outils
// ---------------------------------------------------------------------------

const MINUTE = 60_000;
const ajouterMinutes = (date: Date, minutes: number) => new Date(date.getTime() + minutes * MINUTE);

/** Clé téléphone d'une commande : son numéro, sinon celui du compte. */
export function cleTelephoneCommande(commande: {
  phone?: string | null;
  customer?: { phone?: string | null } | null;
}): string | null {
  return cleTelephone(commande.phone) ?? cleTelephone(commande.customer?.phone);
}

/** Nom affiché du client d'un brouillon. */
export function nomClient(brouillon: Pick<BrouillonLu, 'fullname' | 'customer'>): string {
  const saisi = brouillon.fullname?.trim();
  if (saisi) return saisi;
  const compte = [brouillon.customer?.first_name, brouillon.customer?.last_name]
    .map((v) => v?.trim())
    .filter(Boolean)
    .join(' ');
  return compte || 'Client sans nom';
}

/**
 * Date d'annulation d'un panier annulé par le client, null sinon. Repli sur la
 * création si `cancelled_at` manque (jamais le cas : l'annulation le pose).
 */
export function annuleeParClientLe(brouillon: BrouillonLu): Date | null {
  if (!estPanierAnnuleParClient(brouillon)) return null;
  return brouillon.cancelled_at ?? brouillon.created_at;
}

/** Montant perçu d'un paiement, compté comme partout ailleurs (OrderService). */
const montantPaiement = (p: PaiementLu) => p.total ?? p.amount ?? 0;

/** Somme des paiements réussis d'un brouillon. */
export function totalRecu(brouillon: Pick<BrouillonLu, 'paiements'>): number {
  return (brouillon.paiements ?? [])
    .filter((p) => p.status === PaiementStatus.SUCCESS)
    .reduce((somme, p) => somme + montantPaiement(p), 0);
}

/**
 * Le client a-t-il payé ce panier ? Seulement si les paiements réussis le
 * couvrent, à la tolérance d'arrondi près (`PAYMENT_AMOUNT_TOLERANCE`) : un
 * paiement partiel laisse un reste dû, le client est à rappeler.
 */
export function paiementCouvert(brouillon: Pick<BrouillonLu, 'paiements' | 'amount'>): boolean {
  const recu = totalRecu(brouillon);
  return recu > 0 && etatApresEncaissement(brouillon.amount, recu, OrderStatus.PENDING).soldee;
}

/**
 * Faut-il (re)sonner pour la tête d'un groupe à relancer ? Jamais alertée, ou
 * prise expirée sans traitement depuis la dernière alerte.
 */
export function doitAlerter(relance: RelanceLue | null | undefined, maintenant: Date): boolean {
  if (!relance?.alerte_le) return true;
  const expiration = relance.prise_expire_le;
  return !!expiration && expiration <= maintenant && relance.alerte_le < expiration;
}

/** Une prise est valable tant que sa fin n'est pas atteinte. */
export const priseValable = (relance: RelanceLue | null | undefined, maintenant: Date): boolean =>
  !!relance?.pris_par_id && !!relance.prise_expire_le && relance.prise_expire_le > maintenant;

// ---------------------------------------------------------------------------
// Regroupement par client (union-find)
// ---------------------------------------------------------------------------

/**
 * Deux brouillons appartiennent au même groupe s'ils visent le même
 * restaurant ET le même client : même compte, ou même clé téléphone (elle
 * absorbe les doublons de comptes « 225… » et « +225… »).
 */
export function regrouper(brouillons: BrouillonLu[]): BrouillonLu[][] {
  const parent = brouillons.map((_, i) => i);
  const racine = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const unir = (a: number, b: number) => {
    const ra = racine(a);
    const rb = racine(b);
    if (ra !== rb) parent[rb] = ra;
  };

  const premiers = new Map<string, number>();
  brouillons.forEach((b, i) => {
    const cles = [
      b.customer_id ? `${b.restaurant_id}|compte|${b.customer_id}` : null,
      cleTelephoneCommande(b) ? `${b.restaurant_id}|tel|${cleTelephoneCommande(b)}` : null,
    ];
    for (const cle of cles) {
      if (!cle) continue;
      const premier = premiers.get(cle);
      if (premier === undefined) premiers.set(cle, i);
      else unir(premier, i);
    }
  });

  const groupes = new Map<number, BrouillonLu[]>();
  brouillons.forEach((b, i) => {
    const r = racine(i);
    groupes.set(r, [...(groupes.get(r) ?? []), b]);
  });
  return [...groupes.values()];
}

// ---------------------------------------------------------------------------
// Classement
// ---------------------------------------------------------------------------

/** Le même client, par compte ou par clé téléphone. */
function memeClient(b: BrouillonLu, e: CommandeEffectiveLue): boolean {
  if (b.customer_id && e.customer_id && b.customer_id === e.customer_id) return true;
  const cb = cleTelephoneCommande(b);
  return !!cb && cb === cleTelephoneCommande(e);
}

const plusRecentDAbord = (a: { created_at: Date }, b: { created_at: Date }) =>
  b.created_at.getTime() - a.created_at.getTime() || 0;

/**
 * Les « brouillons » reçus sont les commandes relançables (`RELANCABLE_WHERE`)
 * : paniers en attente ET paniers annulés par le client (01/10). Les seconds
 * suivent exactement les mêmes règles (fenêtre, exclusions, regroupement,
 * délai, prise, ignorance) ; seul le signal `annulee_par_client` les distingue.
 */
export function classerBrouillons(entree: {
  brouillons: BrouillonLu[];
  effectives: CommandeEffectiveLue[];
  maintenant: Date;
  regles: ReglesRelance;
  /** Agent qui lit, pour `par_moi`. */
  moi: string;
}): Classement {
  const { maintenant, regles, moi } = entree;
  const effectives = entree.effectives.filter((e) => e.status !== OrderStatus.CANCELLED);
  const debutFenetre = new Date(maintenant.getTime() - regles.fenetre_heures * 60 * MINUTE);
  const exclus = new Map<string, Exclusion>();

  // 1. Fenêtre, puis exclusions automatiques (1.5), brouillon par brouillon.
  const retenus: BrouillonLu[] = [];
  for (const b of entree.brouillons) {
    if (b.created_at < debutFenetre) continue;
    if (paiementCouvert(b)) {
      exclus.set(b.id, { motif: 'PAIEMENT_A_CONFIRMER' });
      continue;
    }
    const recommande = effectives
      .filter((e) => e.created_at > b.created_at && memeClient(b, e))
      .sort((x, y) => x.created_at.getTime() - y.created_at.getTime())[0];
    if (recommande) {
      exclus.set(b.id, { motif: 'RECOMMANDE', reference: recommande.reference });
      continue;
    }
    retenus.push(b);
  }

  // 2. Regroupement, puis état de chaque groupe (1.4).
  const groupes: GroupeClasse[] = [];
  const groupesIgnores: GroupeIgnore[] = [];
  for (const membres of regrouper(retenus)) {
    const tries = [...membres].sort(plusRecentDAbord);
    const actifs = tries.filter((b) => !b.relance?.ignore_le);
    const ignores = tries
      .filter((b) => !!b.relance?.ignore_le)
      .map((b) => b.id)
      .sort();

    if (actifs.length === 0) {
      groupesIgnores.push({ cle: tries[0].id, restaurant_id: tries[0].restaurant_id, ignores });
      continue;
    }

    const tete = actifs[0];

    // Prise valable sur l'un des paniers : tout le groupe est pris, y compris
    // un panier apparu après la prise.
    const prises = actifs
      .map((b) => b.relance)
      .filter((r): r is RelanceLue => priseValable(r, maintenant))
      .sort((x, y) => y.prise_expire_le!.getTime() - x.prise_expire_le!.getTime());
    const prise: PriseGroupe | null = prises[0]
      ? {
          par_id: prises[0].pris_par_id!,
          par_nom: prises[0].pris_par?.fullname?.trim() || 'un collègue',
          le: prises[0].pris_le,
          expire_le: prises[0].prise_expire_le!,
          par_moi: prises[0].pris_par_id === moi,
        }
      : null;

    // Paiement en cours : panier de tête trop jeune, ou paiement tenté à
    // l'instant sur l'un des paniers (le client repaie un vieux panier).
    const dernierPaiement = actifs
      .flatMap((b) => b.paiements ?? [])
      .reduce<Date | null>((max, p) => (!max || p.created_at > max ? p.created_at : max), null);
    const repereActivite =
      dernierPaiement && dernierPaiement > tete.created_at ? dernierPaiement : tete.created_at;
    const finEnCours = ajouterMinutes(repereActivite, regles.delai_minutes);
    const enCours = finEnCours > maintenant;

    const etat: EtatGroupe = prise ? 'PRIS' : enCours ? 'EN_COURS' : 'A_RELANCER';
    const echeance = etat === 'PRIS' ? prise!.expire_le : etat === 'EN_COURS' ? finEnCours : null;

    // Signaux (1.6) : n'excluent rien.
    const partiel = actifs
      .map((b) => ({ b, recu: totalRecu(b) }))
      .find(({ recu }) => recu > 0);
    const debutRecente = ajouterMinutes(tete.created_at, -regles.recente_minutes);
    const recente = effectives
      .filter((e) => e.created_at >= debutRecente && e.created_at <= tete.created_at && memeClient(tete, e))
      .sort(plusRecentDAbord)[0];
    const annulationTete = annuleeParClientLe(tete);
    const annulation =
      annulationTete ??
      actifs
        .map(annuleeParClientLe)
        .filter((d): d is Date => !!d)
        .reduce<Date | null>((max, d) => (!max || d > max ? d : max), null);

    groupes.push({
      cle: tete.id,
      etat,
      restaurant_id: tete.restaurant_id,
      tete,
      autres: actifs.slice(1),
      ids: actifs.map((b) => b.id).sort(),
      ignores,
      prise,
      echeance,
      signaux: {
        paiement_refuse: actifs.some((b) => (b.paiements ?? []).some((p) => p.status === PaiementStatus.FAILED)),
        paiement_partiel: partiel
          ? { reference: partiel.b.reference, recu: partiel.recu, montant: partiel.b.amount }
          : null,
        commande_recente: recente ? { reference: recente.reference, created_at: recente.created_at } : null,
        annulee_par_client: annulation ? { le: annulation } : null,
      },
    });
  }

  // 3. Ordre de l'écran : mes prises, à relancer (plus ancien d'abord), prises
  // des collègues, paiements en cours.
  const rang = (g: GroupeClasse) =>
    g.etat === 'PRIS' && g.prise?.par_moi ? 0 : g.etat === 'A_RELANCER' ? 1 : g.etat === 'PRIS' ? 2 : 3;
  groupes.sort(
    (a, b) => rang(a) - rang(b) || a.tete.created_at.getTime() - b.tete.created_at.getTime(),
  );

  const prochaineEcheance = groupes
    .map((g) => g.echeance)
    .filter((d): d is Date => !!d)
    .reduce<Date | null>((min, d) => (!min || d < min ? d : min), null);

  return { groupes, groupesIgnores, exclus, prochaineEcheance };
}

/** Groupe (visible ou entièrement ignoré) qui contient une commande. */
export function groupeDeLaCommande(
  classement: Classement,
  orderId: string,
): { visible: GroupeClasse } | { ignore: GroupeIgnore; visible?: undefined } | null {
  const visible = classement.groupes.find((g) => g.ids.includes(orderId) || g.ignores.includes(orderId));
  if (visible) return { visible };
  const ignore = classement.groupesIgnores.find((g) => g.ignores.includes(orderId));
  return ignore ? { ignore } : null;
}
