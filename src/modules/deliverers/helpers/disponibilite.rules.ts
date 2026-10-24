import {
  CourseOfferStatus,
  CourseStatut,
  DelivererStatus,
  EntityStatus,
  Prisma,
} from '@prisma/client';

/**
 * DISPONIBILITÉ D'UN LIVREUR : peut-il recevoir une offre de course ?
 *
 * Demande du 22/10 : « Quand un livreur est en pause il ne doit pas recevoir
 * de commandes. » La pause enregistrée au serveur est la seule vérité, et
 * cette règle unique garde TOUTES les sources d'offre : sélection automatique
 * (filtre Prisma équivalent ci-dessous, test d'équivalence), relances,
 * expiration, affectation forcée par l'admin, acceptation, fusion et ajout de
 * commandes à une course.
 *
 * Un livreur peut recevoir une offre s'il est, à la fois :
 *  - actif et opérationnel (compte validé, restaurant affecté, non supprimé) ;
 *  - ni en pause, ni en pause automatique (sanction après des refus) ;
 *  - sans course acceptée, au restaurant ou en livraison ;
 *  - sans autre offre en attente : l'appli n'en affiche qu'une, et ferme
 *    l'offre affichée à la clôture de N'IMPORTE laquelle ;
 *  - en service : `last_available_at` non nul (il a touché « Reprendre » ou
 *    ouvert l'appli, et ne s'est ni mis en pause ni déconnecté depuis) ;
 *  - appli active (demande du 24/10 : « c'est lorsqu'il ferme la fenêtre que
 *    ça ne doit pas passer ») : au moins un socket ouvert, OU un signe de vie
 *    (position ou requête authentifiée, `dernier_signal_at`) de moins de
 *    `deliverer.appli_fermee_apres_s` secondes (défaut 180, 0 = règle
 *    coupée). En arrière-plan, l'appli envoie ses positions et reste active ;
 *    glissée hors de la liste des applis, elle se tait et le livreur ne
 *    reçoit plus rien jusqu'à sa réouverture, sans pause ni pénalité. Seule
 *    l'appli au protocole 4 au moins est visée : celle d'avant se tait en
 *    arrière-plan et garde ses offres par notification.
 *
 * Le chaînage (offre pendant la dernière livraison) est suspendu : il aura sa
 * propre règle s'il revient (lot 9 de la conception).
 */

/** Pourquoi un livreur ne peut pas recevoir d'offre, par ordre de priorité. */
export type MotifRefusOffre =
  | 'INACTIF'
  | 'EN_PAUSE'
  | 'PAUSE_AUTO'
  | 'EN_COURSE'
  | 'OFFRE_EN_ATTENTE'
  | 'HORS_SERVICE'
  | 'APPLI_FERMEE';

export type DecisionOffre = { ok: true } | { ok: false; motif: MotifRefusOffre };

/** Ce que la règle lit d'un livreur. */
export interface EtatLivreur {
  status: DelivererStatus;
  is_operational: boolean;
  entity_status: EntityStatus;
  pause_until: Date | null;
  auto_pause_until: Date | null;
  last_available_at: Date | null;
  /** Au moins une course ACCEPTED, AT_RESTAURANT ou IN_DELIVERY. */
  en_course: boolean;
  /** Au moins une offre PENDING, échue ou non : tant que la tâche ne l'a pas traitée, elle compte. */
  offre_en_attente: boolean;
  /**
   * Appli active : socket ouvert ou signe de vie récent (`estAppliActive`).
   * Toujours vrai quand la règle est coupée (`deliverer.appli_fermee_apres_s` à 0).
   */
  appli_active: boolean;
  /** Dernier signe de vie de l'appli (`dernier_signal_at`), pour l'affichage. */
  appli_vue_a?: Date | null;
}

/** Une course dont le livreur est occupé : ni offre, ni chaînage. */
export const STATUTS_COURSE_EN_COURS: CourseStatut[] = [
  CourseStatut.ACCEPTED,
  CourseStatut.AT_RESTAURANT,
  CourseStatut.IN_DELIVERY,
];

/**
 * Pause « jusqu'à Reprendre » : bouton de pause sans durée, déconnexion, mise
 * hors service sans signal. Date lointaine plutôt qu'un champ de plus.
 */
export const FIN_PAUSE_INDEFINIE = new Date('2099-12-31T23:59:59Z');

/** Pause manuelle active (`pause_until` dans le futur). */
export function estEnPause(l: Pick<EtatLivreur, 'pause_until'>, maintenant: Date): boolean {
  return l.pause_until !== null && l.pause_until.getTime() > maintenant.getTime();
}

/** Pause automatique active (sanction après des refus répétés). */
export function estEnPauseAuto(
  l: Pick<EtatLivreur, 'auto_pause_until'>,
  maintenant: Date,
): boolean {
  return l.auto_pause_until !== null && l.auto_pause_until.getTime() > maintenant.getTime();
}

/** En service : dans la file, prêt à recevoir des offres. */
export function estEnService(l: Pick<EtatLivreur, 'last_available_at'>): boolean {
  return l.last_available_at !== null;
}

// ============================================================
// APPLI ACTIVE OU FERMÉE
// ============================================================

/** Défaut de `deliverer.appli_fermee_apres_s` : trois minutes sans socket ni signe de vie. */
export const APPLI_FERMEE_APRES_S_DEFAUT = 180;

/**
 * Protocole de l'appli qui garde son suivi en arrière-plan (en-tête
 * `x-deli-protocole`, 4 depuis l'OTA du 24/10). L'appli d'avant (3 ou moins,
 * ou jamais vue) se tait en arrière-plan : la règle de l'appli fermée ne la
 * vise pas, elle garde ses offres par notification, et son état est inconnu
 * à l'écran.
 */
export const PROTOCOLE_APPLI_FERMEE = 4;

/** La règle de l'appli fermée vise-t-elle ce livreur ? Réglage au-dessus de 0 et appli récente. */
export function regleAppliPour(protocoleAppli: number | null | undefined, appliFermeeApresS: number): boolean {
  return appliFermeeApresS > 0 && (protocoleAppli ?? 0) >= PROTOCOLE_APPLI_FERMEE;
}

/**
 * Ce qu'il faut savoir, en plus de la ligne du livreur, pour juger son appli.
 *
 * `connectes` : livreurs dont un socket est ouvert, parmi ceux dont la
 * présence a été demandée au serveur temps réel (ceux dont le signe de vie
 * ne suffit pas). `null` : présence inconnue (Redis muet), l'appli est alors
 * jugée sur son seul signe de vie.
 */
export interface ContexteAppli {
  /** Réglage `deliverer.appli_fermee_apres_s` ; 0 ou moins : règle coupée. */
  appliFermeeApresS: number;
  connectes: ReadonlySet<string> | null;
}

/**
 * Règle de l'appli coupée : réglage à 0, ou livreur qui répond à l'instant
 * (acceptation d'une offre : son appli est forcément ouverte).
 */
export const SANS_REGLE_APPLI: ContexteAppli = { appliFermeeApresS: 0, connectes: null };

/**
 * L'appli du livreur est-elle active ? Oui avec un socket ouvert, ou avec un
 * signe de vie de MOINS de `appliFermeeApresS` secondes (borne exclue). Règle
 * coupée (0) : toujours oui.
 */
export function estAppliActive(
  p: { socket_connecte: boolean | null; dernier_signal_at: Date | null },
  maintenant: Date,
  appliFermeeApresS: number,
): boolean {
  if (!(appliFermeeApresS > 0)) return true;
  if (p.socket_connecte === true) return true;
  return (
    p.dernier_signal_at !== null &&
    maintenant.getTime() - p.dernier_signal_at.getTime() < appliFermeeApresS * 1000
  );
}

/**
 * Appli active d'une ligne lue en base (`id`, `dernier_signal_at`,
 * `protocole_appli`) dans ce contexte. Appli d'avant le protocole 4 :
 * toujours active (la règle ne la vise pas).
 */
export function appliActiveDepuis(
  ligne: { id: string; dernier_signal_at: Date | null; protocole_appli: number | null },
  appli: ContexteAppli,
  maintenant: Date,
): boolean {
  if (!regleAppliPour(ligne.protocole_appli, appli.appliFermeeApresS)) return true;
  return estAppliActive(
    {
      socket_connecte: appli.connectes ? appli.connectes.has(ligne.id) : null,
      dernier_signal_at: ligne.dernier_signal_at,
    },
    maintenant,
    appli.appliFermeeApresS,
  );
}

export function peutRecevoirOffre(l: EtatLivreur, maintenant: Date): DecisionOffre {
  if (
    l.status !== DelivererStatus.ACTIVE ||
    !l.is_operational ||
    l.entity_status !== EntityStatus.ACTIVE
  ) {
    return { ok: false, motif: 'INACTIF' };
  }
  if (estEnPause(l, maintenant)) return { ok: false, motif: 'EN_PAUSE' };
  if (estEnPauseAuto(l, maintenant)) return { ok: false, motif: 'PAUSE_AUTO' };
  if (l.en_course) return { ok: false, motif: 'EN_COURSE' };
  if (l.offre_en_attente) return { ok: false, motif: 'OFFRE_EN_ATTENTE' };
  if (!estEnService(l)) return { ok: false, motif: 'HORS_SERVICE' };
  if (!l.appli_active) return { ok: false, motif: 'APPLI_FERMEE' };
  return { ok: true };
}

/**
 * La même règle, en filtre Prisma, pour la sélection des candidats. Toute
 * modification de `peutRecevoirOffre` doit s'y refléter : le test
 * d'équivalence (disponibilite.rules.spec.ts) casse sinon.
 *
 * Bornes : la pause est active quand sa fin est STRICTEMENT future, donc le
 * livreur redevient candidat dès `pause_until <= maintenant` (`lte`) ; l'appli
 * est active avec un signe de vie de MOINS de N secondes, donc postérieur à
 * `maintenant - N` (`gt`).
 *
 * @param appli  Réglage et sockets ouverts (`AppliLivreurService`) : les
 *   livreurs au signe de vie trop vieux ne passent que par leur socket.
 */
export function filtreLivreursPouvantRecevoirOffre(
  maintenant: Date,
  appli: ContexteAppli,
): Prisma.DelivererWhereInput {
  const conditions: Prisma.DelivererWhereInput[] = [
    { OR: [{ pause_until: null }, { pause_until: { lte: maintenant } }] },
    { OR: [{ auto_pause_until: null }, { auto_pause_until: { lte: maintenant } }] },
    { courses: { none: { statut: { in: STATUTS_COURSE_EN_COURS } } } },
    { offer_attempts: { none: { status: CourseOfferStatus.PENDING } } },
  ];
  if (appli.appliFermeeApresS > 0) {
    const connectes = [...(appli.connectes ?? [])];
    conditions.push({
      OR: [
        // Appli d'avant le protocole 4 : la règle ne la vise pas.
        { protocole_appli: null },
        { protocole_appli: { lt: PROTOCOLE_APPLI_FERMEE } },
        { dernier_signal_at: { gt: new Date(maintenant.getTime() - appli.appliFermeeApresS * 1000) } },
        ...(connectes.length > 0 ? [{ id: { in: connectes } }] : []),
      ],
    });
  }
  return {
    status: DelivererStatus.ACTIVE,
    is_operational: true,
    entity_status: EntityStatus.ACTIVE,
    last_available_at: { not: null },
    AND: conditions,
  };
}

/**
 * Lecture de l'état d'UN livreur (affectation forcée, acceptation, relances) :
 * `prisma.deliverer.findUnique({ where: { id }, select: SELECT_ETAT_LIVREUR })`
 * puis `etatLivreurDepuis(ligne, appli, maintenant)`.
 */
export const SELECT_ETAT_LIVREUR = {
  id: true,
  restaurant_id: true,
  status: true,
  is_operational: true,
  entity_status: true,
  pause_until: true,
  auto_pause_until: true,
  last_available_at: true,
  dernier_signal_at: true,
  protocole_appli: true,
  _count: {
    select: {
      courses: { where: { statut: { in: STATUTS_COURSE_EN_COURS } } },
      offer_attempts: { where: { status: CourseOfferStatus.PENDING } },
    },
  },
} satisfies Prisma.DelivererSelect;

export type LigneEtatLivreur = Prisma.DelivererGetPayload<{ select: typeof SELECT_ETAT_LIVREUR }>;

export function etatLivreurDepuis(
  ligne: LigneEtatLivreur,
  appli: ContexteAppli,
  maintenant: Date,
): EtatLivreur {
  return {
    status: ligne.status,
    is_operational: ligne.is_operational,
    entity_status: ligne.entity_status,
    pause_until: ligne.pause_until,
    auto_pause_until: ligne.auto_pause_until,
    last_available_at: ligne.last_available_at,
    en_course: ligne._count.courses > 0,
    offre_en_attente: ligne._count.offer_attempts > 0,
    appli_active: appliActiveDepuis(ligne, appli, maintenant),
    appli_vue_a: ligne.dernier_signal_at,
  };
}

// ============================================================
// TEXTES (français simple, heure d'Abidjan = UTC)
// ============================================================

/** « 14 h 32 », ou « le 23/10 à 14 h 32 » si ce n'est pas le même jour. */
export function heureLisible(date: Date, maintenant: Date): string {
  const heure = `${date.getUTCHours()} h ${String(date.getUTCMinutes()).padStart(2, '0')}`;
  const memeJour =
    date.getUTCFullYear() === maintenant.getUTCFullYear() &&
    date.getUTCMonth() === maintenant.getUTCMonth() &&
    date.getUTCDate() === maintenant.getUTCDate();
  if (memeJour) return heure;
  const jour = String(date.getUTCDate()).padStart(2, '0');
  const mois = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `le ${jour}/${mois} à ${heure}`;
}

const estIndefinie = (date: Date) => date.getTime() >= FIN_PAUSE_INDEFINIE.getTime() - 24 * 3600_000;

/** « jusqu'à 14 h 32 », « jusqu'au 23/10 à 14 h 32 », ou rien pour une pause sans fin. */
function jusqua(date: Date | null, maintenant: Date): string {
  if (!date || estIndefinie(date)) return '';
  const h = heureLisible(date, maintenant);
  return h.startsWith('le ') ? ` jusqu'au ${h.slice(3)}` : ` jusqu'à ${h}`;
}

/** Réponse à « Reprendre » pendant une pause automatique. */
export function messagePauseAuto(autoPauseUntil: Date, maintenant: Date): string {
  return `Pause automatique${jusqua(autoPauseUntil, maintenant)}.`;
}

// ============================================================
// AFFICHAGE AU BACKOFFICE (liste des livreurs, carte, affectation forcée)
// ============================================================

/** État d'un livreur pour l'affichage : disponible, ou la raison du refus. */
export type EtatAffichageLivreur = 'DISPONIBLE' | MotifRefusOffre;

/** Ce que le serveur renvoie à côté de chaque livreur (champ `disponibilite`). */
export interface DisponibiliteLivreur {
  etat: EtatAffichageLivreur;
  /** Texte à afficher tel quel : « En pause jusqu'à 14 h 32 », « Hors service »… */
  libelle: string;
  /** Peut recevoir une offre (et donc une affectation forcée) maintenant. */
  peut_recevoir_offre: boolean;
  /** Raison du refus d'une affectation forcée, telle que le serveur la renverrait (409). */
  message_refus: string | null;
  en_pause: boolean;
  en_pause_auto: boolean;
  pause_until: Date | null;
  auto_pause_until: Date | null;
  /** Dans la file (`last_available_at` non nul). */
  en_service: boolean;
  en_course: boolean;
  offre_en_attente: boolean;
  /** Course de l'offre en attente : l'affectation forcée sur CETTE course reste permise (renvoi). */
  offre_course_id: string | null;
  /**
   * Appli active : socket ouvert ou signe de vie récent. Faux : « Appli
   * fermée », plus aucune offre jusqu'à sa réouverture. Null : règle coupée
   * (`deliverer.appli_fermee_apres_s` à 0), état de l'appli inconnu.
   */
  appli_active: boolean | null;
  /** Dernier signe de vie de l'appli (position ou requête), null si jamais vu. */
  appli_vue_a: Date | null;
}

const LIBELLES: Record<EtatAffichageLivreur, string> = {
  DISPONIBLE: 'Disponible',
  INACTIF: 'Inactif',
  EN_PAUSE: 'En pause',
  PAUSE_AUTO: 'Pause automatique',
  EN_COURSE: 'En course',
  OFFRE_EN_ATTENTE: 'Offre en attente',
  HORS_SERVICE: 'Hors service',
  APPLI_FERMEE: 'Appli fermée',
};

/**
 * État d'un livreur à afficher au backoffice, calculé par la règle unique :
 * l'écran montre exactement ce que le serveur refuserait.
 *
 * @param regleAppli  Règle de l'appli fermée active (réglage au-dessus de 0).
 *   Coupée, la règle tient toute appli pour active ; l'écran, lui, ne sait
 *   pas : `appli_active` vaut null (« Appli non connectée » sans socket).
 */
export function disponibiliteLivreur(
  l: EtatLivreur,
  maintenant: Date,
  offreCourseId: string | null = null,
  regleAppli = true,
): DisponibiliteLivreur {
  const decision = peutRecevoirOffre(l, maintenant);
  const etat: EtatAffichageLivreur = decision.ok ? 'DISPONIBLE' : decision.motif;
  let libelle = LIBELLES[etat];
  if (etat === 'EN_PAUSE') libelle += jusqua(l.pause_until, maintenant);
  if (etat === 'PAUSE_AUTO') libelle += jusqua(l.auto_pause_until, maintenant);
  return {
    etat,
    libelle,
    peut_recevoir_offre: decision.ok,
    message_refus: decision.ok ? null : messageRefusOffre(decision.motif, l, maintenant),
    en_pause: estEnPause(l, maintenant),
    en_pause_auto: estEnPauseAuto(l, maintenant),
    pause_until: l.pause_until,
    auto_pause_until: l.auto_pause_until,
    en_service: estEnService(l),
    en_course: l.en_course,
    offre_en_attente: l.offre_en_attente,
    offre_course_id: l.offre_en_attente ? offreCourseId : null,
    appli_active: regleAppli ? l.appli_active : null,
    appli_vue_a: l.appli_vue_a ?? null,
  };
}

/**
 * Raison, en français, pour laquelle un livreur ne peut pas recevoir d'offre
 * (refus de l'affectation forcée, affichage au backoffice).
 */
export function messageRefusOffre(
  motif: MotifRefusOffre,
  l: Pick<EtatLivreur, 'pause_until' | 'auto_pause_until'>,
  maintenant: Date,
): string {
  switch (motif) {
    case 'INACTIF':
      return "Ce livreur n'est pas actif ou n'est rattaché à aucun restaurant.";
    case 'EN_PAUSE':
      return `Ce livreur est en pause${jusqua(l.pause_until, maintenant)}.`;
    case 'PAUSE_AUTO':
      return `Ce livreur est en pause automatique${jusqua(l.auto_pause_until, maintenant)}.`;
    case 'EN_COURSE':
      return 'Ce livreur a déjà une course en cours.';
    case 'OFFRE_EN_ATTENTE':
      return 'Ce livreur a déjà une offre en attente de réponse.';
    case 'HORS_SERVICE':
      return "Ce livreur est hors service : il n'a pas repris le travail dans l'appli.";
    case 'APPLI_FERMEE':
      return "L'appli de ce livreur est fermée.";
  }
}
