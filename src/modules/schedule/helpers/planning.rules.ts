import { ForbiddenException } from '@nestjs/common';
import { Genre, SchedulePlanStatus, User } from '@prisma/client';

import { assertCanAccessRestaurant } from 'src/modules/order/helpers/restaurant-scope.helper';

/**
 * Règles pures du planning modifiable dans ses quatre états (conception du
 * 24/10, 11.6) : qui est prévenu, ce qui va au journal, et les textes.
 *
 * Les dates d'un planning sont des dates pures (`@db.Date`, minuit UTC) et
 * Abidjan vit en UTC toute l'année : tout est lu en UTC.
 */

// Refus montrés au backoffice : les mots d'avant (serveur ca20651, écran
// Planning), « plan » pour un plan de la liste, « planning » quand un livreur
// y est ajouté ou retiré.
export const MESSAGE_PLANNING_AUTRE_RESTAURANT = "Ce plan n'est pas celui de votre restaurant.";
export const MESSAGE_GENERER_AUTRE_RESTAURANT =
  'Vous ne pouvez générer un plan que pour votre restaurant.';
export const MESSAGE_PLANNING_INTROUVABLE = 'Plan introuvable.';
export const MESSAGE_PLANNING_CHANGE = 'Ce plan vient de changer. Rechargez la page.';
export const MESSAGE_PAS_SUR_LE_PLANNING = "Ce livreur n'est pas sur ce planning.";
export const MESSAGE_DEJA_SUR_LE_PLANNING = 'Ce livreur est déjà présent dans ce planning.';
/** Ajout d'un livreur au plan. */
export const MESSAGE_LIVREUR_PAS_ACTIF =
  'Livreur introuvable, inactif, ou non rattaché au restaurant de ce plan.';
/** Jour d'un livreur changé. */
export const MESSAGE_LIVREUR_HORS_RESTAURANT = 'Livreur introuvable ou non rattaché à ce restaurant';
export const MESSAGE_JOUR_HORS_PLANNING = 'Date hors de la période du plan';
export const MESSAGE_JOUR_SANS_REPOS = 'Repos interdit ce jour-là : jour de forte activité.';
export const MESSAGE_ENVOI_HORS_BROUILLON = 'Seul un plan brouillon peut être envoyé.';
export const MESSAGE_CONFIRMATION_HORS_ENVOYE = 'Seul un plan envoyé peut être confirmé.';

/** Nom d'un état dans les refus montrés à l'écran (section 3.3). */
export const NOM_ETAT: Record<SchedulePlanStatus, string> = {
  [SchedulePlanStatus.DRAFT]: 'Brouillon',
  [SchedulePlanStatus.SENT]: 'Envoyé',
  [SchedulePlanStatus.CONFIRMED]: 'Confirmé',
  [SchedulePlanStatus.ARCHIVED]: 'Archivé',
};

/**
 * Refus d'un geste sur un planning archivé, un jour qu'un planning en cours
 * du restaurant couvre aussi : le repos de ce jour est le sien.
 */
export function messageJourDuPlanningEnCours(autre: {
  status: SchedulePlanStatus;
  period_start: Date;
  period_end: Date;
}): string {
  return (
    `Ce jour est dans le plan (${periodePlan(autre.period_start, autre.period_end)}, ` +
    `${NOM_ETAT[autre.status]}). Changez-le depuis ce plan.`
  );
}

/**
 * Refus de générer un plan sur des dates qu'un autre plan couvre déjà : le
 * texte d'avant, avec la période et l'état lisibles.
 */
export function messageChevauchement(autre: {
  status: SchedulePlanStatus;
  period_start: Date;
  period_end: Date;
}): string {
  return (
    `Chevauchement avec le plan (${periodePlan(autre.period_start, autre.period_end)}, ` +
    `${NOM_ETAT[autre.status]}). Archive ou supprime ce plan avant d'en générer un nouveau pour cette période.`
  );
}

/**
 * Cloisonnement : un compte de restaurant (manager, assistant) ne touche
 * qu'aux plannings de SON restaurant. Même règle que
 * `assertCanAccessRestaurant`, avec la phrase du planning.
 */
export function verifierPlanningDuRestaurant(
  user: User | undefined,
  restaurantId: string | null | undefined,
  message: string = MESSAGE_PLANNING_AUTRE_RESTAURANT,
): void {
  try {
    assertCanAccessRestaurant(user, restaurantId);
  } catch (e) {
    if (e instanceof ForbiddenException) throw new ForbiddenException(message);
    throw e;
  }
}

/** Un geste sur le planning, pour savoir qui prévenir et quoi noter. */
export type GestePlanning = 'jour' | 'ajout' | 'retrait' | 'dates' | 'suppression';

export const ACTION_JOURNAL_ARCHIVE_MODIFIE = 'PLANNING_ARCHIVE_MODIFIE';
export const ACTION_JOURNAL_SUPPRIME = 'PLANNING_SUPPRIME';

/**
 * Le livreur voit un planning envoyé ou confirmé, pas un brouillon ni un
 * archivé : on ne le prévient que pour ces deux états.
 */
export function prevenirLesLivreurs(statut: SchedulePlanStatus): boolean {
  return statut === SchedulePlanStatus.SENT || statut === SchedulePlanStatus.CONFIRMED;
}

/**
 * Ligne lisible au journal d'audit : tout geste sur un planning archivé, et
 * la suppression d'un planning confirmé. `null` : rien de plus que la ligne
 * que l'intercepteur écrit déjà pour toute modification.
 */
export function actionAuJournal(statut: SchedulePlanStatus, geste: GestePlanning): string | null {
  if (statut === SchedulePlanStatus.ARCHIVED) {
    return geste === 'suppression' ? ACTION_JOURNAL_SUPPRIME : ACTION_JOURNAL_ARCHIVE_MODIFIE;
  }
  if (statut === SchedulePlanStatus.CONFIRMED && geste === 'suppression') return ACTION_JOURNAL_SUPPRIME;
  return null;
}

// ── Textes ────────────────────────────────────────────────────────────────

const JOURS_COURTS = ['Dim.', 'Lun.', 'Mar.', 'Mer.', 'Jeu.', 'Ven.', 'Sam.'];

const deux = (n: number) => String(n).padStart(2, '0');

/** « 27/10 » */
export function dateCourte(d: Date): string {
  return `${deux(d.getUTCDate())}/${deux(d.getUTCMonth() + 1)}`;
}

/** « Lun. 27/10 » */
export function jourCourt(d: Date): string {
  return `${JOURS_COURTS[d.getUTCDay()]} ${dateCourte(d)}`;
}

/** « 27/10 au 09/11 » (notifications au livreur) */
export function periode(debut: Date, fin: Date): string {
  return `${dateCourte(debut)} au ${dateCourte(fin)}`;
}

/** Mois abrégés comme date-fns en français, le format d'avant au backoffice. */
const MOIS_COURTS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];

const jourEtMois = (d: Date): string => `${deux(d.getUTCDate())} ${MOIS_COURTS[d.getUTCMonth()]}`;

/** « 27 oct. → 09 nov. 2026 » : période d'un plan, comme l'écran Planning du backoffice. */
export function periodePlan(debut: Date, fin: Date): string {
  return `${jourEtMois(debut)} → ${jourEtMois(fin)} ${fin.getUTCFullYear()}`;
}

interface LivreurNomme {
  first_name?: string | null;
  last_name?: string | null;
  genre?: Genre | null;
}

/** « Koffi Yao » */
export function nomLivreur(l: LivreurNomme | null | undefined): string {
  const nom = [l?.first_name, l?.last_name].map((s) => s?.trim()).filter(Boolean).join(' ');
  return nom || 'Livreur sans nom';
}

/** « retiré », « retirée » : accord sur le genre du livreur, masculin s'il manque. */
function accorde(participe: string, l: LivreurNomme | null | undefined): string {
  return l?.genre === Genre.FEMME ? `${participe}e` : participe;
}

/** « d'Angré », « de Marcory » */
export function deRestaurant(nom: string | null | undefined): string {
  const n = (nom ?? '').trim() || 'restaurant inconnu';
  return /^[aeiouàâäéèêëîïôöùûüœæ]/i.test(n) ? `d'${n}` : `de ${n}`;
}

const ADJECTIF_ETAT: Record<SchedulePlanStatus, string> = {
  [SchedulePlanStatus.DRAFT]: 'brouillon',
  [SchedulePlanStatus.SENT]: 'envoyé',
  [SchedulePlanStatus.CONFIRMED]: 'confirmé',
  [SchedulePlanStatus.ARCHIVED]: 'archivé',
};

export interface PlanningNomme {
  status: SchedulePlanStatus;
  period_start: Date;
  period_end: Date;
  restaurant?: { name?: string | null } | null;
}

/** « Plan archivé d'Angré (13 oct. → 26 oct. 2026) », les mots de l'écran Planning. */
function enTeteJournal(plan: PlanningNomme): string {
  return (
    `Plan ${ADJECTIF_ETAT[plan.status]} ${deRestaurant(plan.restaurant?.name)} ` +
    `(${periodePlan(plan.period_start, plan.period_end)})`
  );
}

export type ResumeJournal =
  | { geste: 'jour'; livreur: LivreurNomme | null; mode: 'REST' | 'WORK'; date: Date }
  | { geste: 'ajout'; livreur: LivreurNomme | null }
  | { geste: 'retrait'; livreur: LivreurNomme | null }
  | { geste: 'dates'; debut: Date; fin: Date }
  | { geste: 'suppression' };

/**
 * Phrase du journal d'audit :
 *  « Plan archivé d'Angré (13 oct. → 26 oct. 2026) : Koffi Yao en repos le 21/10 »,
 *  « Plan confirmé d'Angré (27 oct. → 09 nov. 2026) supprimé ».
 */
export function resumeJournal(plan: PlanningNomme, r: ResumeJournal): string {
  const tete = enTeteJournal(plan);
  switch (r.geste) {
    case 'jour':
      return `${tete} : ${nomLivreur(r.livreur)} ${r.mode === 'REST' ? 'en repos' : 'au travail'} le ${dateCourte(r.date)}`;
    case 'ajout':
      return `${tete} : ${nomLivreur(r.livreur)} ${accorde('ajouté', r.livreur)}`;
    case 'retrait':
      return `${tete} : ${nomLivreur(r.livreur)} ${accorde('retiré', r.livreur)}`;
    case 'dates':
      return `${tete} : régénéré pour les nouvelles dates (${periodePlan(r.debut, r.fin)})`;
    case 'suppression':
      return `${tete} supprimé`;
  }
}

/** Notification au livreur (tutoiement), une par geste. */
export interface NotificationPlanning {
  type: 'plan_sent' | 'plan_modifie';
  titre: string;
  texte: string;
}

/**
 * Jour passé au travail : `plan_sent`, pour que l'appli ouvre le planning et
 * demande de confirmer. Jour passé en repos : `plan_modifie`, rien à confirmer.
 */
export function notificationJour(mode: 'REST' | 'WORK', date: Date): NotificationPlanning {
  return mode === 'WORK'
    ? { type: 'plan_sent', titre: 'Planning modifié', texte: `${jourCourt(date)} : créneaux à confirmer` }
    : { type: 'plan_modifie', titre: 'Planning modifié', texte: `${jourCourt(date)} : repos` };
}

export function notificationRetrait(plan: PlanningNomme): NotificationPlanning {
  return {
    type: 'plan_modifie',
    titre: 'Planning modifié',
    texte: `Tu n'es plus sur le planning du ${periode(plan.period_start, plan.period_end)}`,
  };
}

export function notificationDates(plan: PlanningNomme): NotificationPlanning {
  return {
    type: 'plan_modifie',
    titre: 'Planning modifié',
    texte: `Le planning du ${periode(plan.period_start, plan.period_end)} est refait`,
  };
}

export function notificationSuppression(plan: PlanningNomme): NotificationPlanning {
  return {
    type: 'plan_modifie',
    titre: 'Planning annulé',
    texte: `Le planning du ${periode(plan.period_start, plan.period_end)} est annulé`,
  };
}

// ── Aperçu des plannings du réseau ──────────────────────────────────────────

export interface PlanningLu {
  id: string;
  status: SchedulePlanStatus;
  period_start: Date;
  period_end: Date;
}

/** Les états qu'on montre d'abord quand deux plannings couvrent le même jour. */
const PRIORITE_EN_COURS: SchedulePlanStatus[] = [
  SchedulePlanStatus.CONFIRMED,
  SchedulePlanStatus.SENT,
  SchedulePlanStatus.DRAFT,
];

/**
 * Planning en cours et planning suivant d'un restaurant, à partir de ses
 * plannings non archivés (un archivé n'est plus vu par les livreurs).
 *
 * - en cours : celui qui couvre `aujourdhui` (confirmé, puis envoyé, puis
 *   brouillon s'il y en avait plusieurs) ;
 * - suivant : le premier qui commence après la fin du planning en cours, ou
 *   après aujourd'hui s'il n'y en a pas.
 */
export function planningsDuRestaurant(
  plannings: PlanningLu[],
  aujourdhui: Date,
): { en_cours: PlanningLu | null; suivant: PlanningLu | null } {
  const jour = aujourdhui.getTime();
  const actifs = plannings.filter((p) => p.status !== SchedulePlanStatus.ARCHIVED);

  const couvrants = actifs.filter(
    (p) => p.period_start.getTime() <= jour && p.period_end.getTime() >= jour,
  );
  couvrants.sort(
    (a, b) =>
      PRIORITE_EN_COURS.indexOf(a.status) - PRIORITE_EN_COURS.indexOf(b.status) ||
      a.period_start.getTime() - b.period_start.getTime(),
  );
  const en_cours = couvrants[0] ?? null;

  const apres = en_cours ? en_cours.period_end.getTime() : jour;
  const suivant =
    actifs
      .filter((p) => p.id !== en_cours?.id && p.period_start.getTime() > apres)
      .sort((a, b) => a.period_start.getTime() - b.period_start.getTime())[0] ?? null;

  return { en_cours, suivant };
}

/** Minuit UTC du jour de `d`. */
export function debutDuJour(d: Date): Date {
  const out = new Date(d);
  out.setUTCHours(0, 0, 0, 0);
  return out;
}
