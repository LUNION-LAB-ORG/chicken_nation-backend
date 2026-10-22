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
 *    ouvert l'appli, et ne s'est ni mis en pause ni déconnecté depuis).
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
  | 'HORS_SERVICE';

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
  return { ok: true };
}

/**
 * La même règle, en filtre Prisma, pour la sélection des candidats. Toute
 * modification de `peutRecevoirOffre` doit s'y refléter : le test
 * d'équivalence (disponibilite.rules.spec.ts) casse sinon.
 *
 * Bornes : la pause est active quand sa fin est STRICTEMENT future, donc le
 * livreur redevient candidat dès `pause_until <= maintenant` (`lte`).
 */
export function filtreLivreursPouvantRecevoirOffre(maintenant: Date): Prisma.DelivererWhereInput {
  return {
    status: DelivererStatus.ACTIVE,
    is_operational: true,
    entity_status: EntityStatus.ACTIVE,
    last_available_at: { not: null },
    AND: [
      { OR: [{ pause_until: null }, { pause_until: { lte: maintenant } }] },
      { OR: [{ auto_pause_until: null }, { auto_pause_until: { lte: maintenant } }] },
      { courses: { none: { statut: { in: STATUTS_COURSE_EN_COURS } } } },
      { offer_attempts: { none: { status: CourseOfferStatus.PENDING } } },
    ],
  };
}

/**
 * Lecture de l'état d'UN livreur (affectation forcée, acceptation, relances) :
 * `prisma.deliverer.findUnique({ where: { id }, select: SELECT_ETAT_LIVREUR })`
 * puis `etatLivreurDepuis(ligne)`.
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
  _count: {
    select: {
      courses: { where: { statut: { in: STATUTS_COURSE_EN_COURS } } },
      offer_attempts: { where: { status: CourseOfferStatus.PENDING } },
    },
  },
} satisfies Prisma.DelivererSelect;

export type LigneEtatLivreur = Prisma.DelivererGetPayload<{ select: typeof SELECT_ETAT_LIVREUR }>;

export function etatLivreurDepuis(ligne: LigneEtatLivreur): EtatLivreur {
  return {
    status: ligne.status,
    is_operational: ligne.is_operational,
    entity_status: ligne.entity_status,
    pause_until: ligne.pause_until,
    auto_pause_until: ligne.auto_pause_until,
    last_available_at: ligne.last_available_at,
    en_course: ligne._count.courses > 0,
    offre_en_attente: ligne._count.offer_attempts > 0,
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
}

const LIBELLES: Record<EtatAffichageLivreur, string> = {
  DISPONIBLE: 'Disponible',
  INACTIF: 'Inactif',
  EN_PAUSE: 'En pause',
  PAUSE_AUTO: 'Pause automatique',
  EN_COURSE: 'En course',
  OFFRE_EN_ATTENTE: 'Offre en attente',
  HORS_SERVICE: 'Hors service',
};

/**
 * État d'un livreur à afficher au backoffice, calculé par la règle unique :
 * l'écran montre exactement ce que le serveur refuserait.
 */
export function disponibiliteLivreur(
  l: EtatLivreur,
  maintenant: Date,
  offreCourseId: string | null = null,
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
  }
}
