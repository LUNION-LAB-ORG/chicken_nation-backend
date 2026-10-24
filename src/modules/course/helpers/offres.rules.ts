import { CourseStatut, DeliveryService } from '@prisma/client';

import {
  EtatLivreur,
  MotifRefusOffre,
  messagePauseAuto,
  peutRecevoirOffre,
} from 'src/modules/deliverers/helpers/disponibilite.rules';

/**
 * RÈGLES DES OFFRES (relance, expiration, affectation forcée, acceptation),
 * pures et testées. Toutes s'appuient sur la règle unique `peutRecevoirOffre`
 * (deliverers/helpers/disponibilite.rules.ts) : demande du 22/10, un livreur
 * en pause ne reçoit aucune course, quelle que soit la source de l'offre.
 */

/**
 * Classe du verrou consultatif « une seule offre en attente par livreur »
 * (`hashtext(deliverer_id)`), tenu pendant la création d'une offre et pendant
 * la lecture des offres d'un livreur à clore (pause, déconnexion). Voir
 * `CLASSE_VERROU_CODE_RETRAIT` (727227) dans course.helper.ts ; 727224 à
 * 727226 sont au CRM.
 */
export const CLASSE_VERROU_OFFRE_LIVREUR = 727228;

/** Refus de l'acceptation pour une course qui ne cherche plus de livreur. */
export const MESSAGE_COURSE_PLUS_DISPONIBLE = "Cette course n'est plus disponible.";
/** Refus de l'affectation forcée sur une course acceptée, terminée ou confiée à Turbo. */
export const MESSAGE_COURSE_NE_CHERCHE_PLUS = 'Cette course ne cherche plus de livreur.';

/** Ce que les règles lisent d'une course. */
export interface EtatCourse {
  statut: CourseStatut;
  turbo_escalated_at: Date | null;
}

/** La course cherche encore un livreur interne : en recherche et pas confiée à Turbo. */
export function courseChercheLivreur(c: EtatCourse | null | undefined): boolean {
  return !!c && c.statut === CourseStatut.PENDING_ASSIGNMENT && c.turbo_escalated_at === null;
}

/**
 * Course TURBO D'ORIGINE : toutes ses commandes sont livrées par Turbo (zone,
 * choix de l'administration). Jamais d'offre à un livreur interne, même quand
 * son envoi à Turbo a échoué et attend d'être retenté (`turbo_escalated_at`
 * remis à nul) : même règle que `retryUnassignedCourses`.
 */
export function estCourseTurboDOrigine(
  livraisons: { order: { delivery_service?: DeliveryService | null } }[],
): boolean {
  return livraisons.length > 0 && livraisons.every((l) => l.order.delivery_service === DeliveryService.TURBO);
}

// ============================================================
// CRÉATION D'UNE OFFRE (offerToDeliverer, sous le verrou du livreur)
// ============================================================

/**
 * Dernier contrôle avant d'écrire une offre, quelle qu'en soit la source
 * (sélection automatique, affectation forcée, relance de la recherche) : la
 * règle unique relue SOUS le verrou du livreur. Une pause posée entre la
 * sélection et l'écriture l'emporte donc toujours.
 *
 * @param autreOffreEnAttente  Offre en attente pour une AUTRE course (celle de
 *   cette course, en cas de renvoi, ne compte pas).
 * @param chainage  Offre de chaînage (suspendu, lot 9) : seule exception à « en course ».
 */
export function decisionCreationOffre(
  livreur: EtatLivreur | null | undefined,
  autreOffreEnAttente: boolean,
  maintenant: Date,
  chainage = false,
): ReturnType<typeof peutRecevoirOffre> {
  if (!livreur) return { ok: false, motif: 'INACTIF' };
  return peutRecevoirOffre(
    {
      ...livreur,
      offre_en_attente: autreOffreEnAttente,
      en_course: chainage ? false : livreur.en_course,
    },
    maintenant,
  );
}

// ============================================================
// EXPIRATION
// ============================================================

/** Pourquoi une offre expirée ne coûte rien au livreur. */
export type RaisonExpirationSansPenalite = 'COURSE_PLUS_EN_RECHERCHE' | 'LIVREUR_EN_PAUSE' | 'APPLI_FERMEE';

export type DecisionExpiration =
  | { penaliser: true }
  | { penaliser: false; raison: RaisonExpirationSansPenalite };

/**
 * Une offre laissée sans réponse coûte une pénalité de file au livreur et un
 * refus à la course, SAUF :
 *  - si la course ne cherche plus de livreur (acceptée par un autre,
 *    fusionnée, annulée, confiée à Turbo) : l'offre avait disparu ;
 *  - si le livreur s'est mis en pause entre-temps (pause manuelle ou
 *    automatique) : sa pause aurait dû clore l'offre ;
 *  - si l'appli du livreur est fermée (demande du 24/10) : il n'a pas pu la
 *    voir. L'offre est alors close (`APPLI_FERMEE`), pas expirée : elle ne
 *    l'exclut pas non plus de la course.
 */
export function decisionExpiration(
  course: EtatCourse | null | undefined,
  livreur: Pick<EtatLivreur, 'pause_until' | 'auto_pause_until' | 'appli_active'> | null | undefined,
  maintenant: Date,
): DecisionExpiration {
  if (!courseChercheLivreur(course)) return { penaliser: false, raison: 'COURSE_PLUS_EN_RECHERCHE' };
  const enPause =
    !!livreur &&
    ((livreur.pause_until !== null && livreur.pause_until.getTime() > maintenant.getTime()) ||
      (livreur.auto_pause_until !== null && livreur.auto_pause_until.getTime() > maintenant.getTime()));
  if (enPause) return { penaliser: false, raison: 'LIVREUR_EN_PAUSE' };
  if (livreur && !livreur.appli_active) return { penaliser: false, raison: 'APPLI_FERMEE' };
  return { penaliser: true };
}

/**
 * Signe de vie qui compte à l'échéance d'une offre : seulement s'il est
 * postérieur à l'envoi de l'offre. Un signe de vie plus ancien ne prouve pas
 * que l'appli vivait encore pendant l'offre : glissée hors de la liste juste
 * avant, elle reste « active » jusqu'à 180 s et l'offre lui serait comptée.
 * Sans signe de vie pendant l'offre, seul un socket ouvert à l'échéance la
 * rend active (l'appli en arrière-plan envoie une position toutes les 45 à
 * 85 s, l'offre dure 120 s). Envoi inconnu : le signe de vie compte tel quel.
 */
export function signalPendantOffre(dernierSignal: Date | null, offreeA: Date | null | undefined): Date | null {
  if (!dernierSignal || !offreeA) return dernierSignal;
  return dernierSignal.getTime() > offreeA.getTime() ? dernierSignal : null;
}

// ============================================================
// RELANCES (30 et 60 s)
// ============================================================

export type DecisionRelance =
  | { relancer: true }
  | {
      relancer: false;
      /** Motif de clôture de l'offre (OffresClotureService). */
      motif: 'COURSE_PLUS_EN_RECHERCHE' | 'LIVREUR_INDISPONIBLE' | 'APPLI_FERMEE';
      /** Pour `LIVREUR_INDISPONIBLE` et `APPLI_FERMEE` : ce que dit la règle du livreur. */
      motif_livreur?: MotifRefusOffre;
    };

/**
 * Une relance ne part que si l'offre vaut encore : course toujours en
 * recherche, livreur toujours en état de la recevoir. Sinon l'offre est close
 * (sans pénalité) et la recherche repart.
 *
 * L'offre relancée est elle-même « en attente » : elle ne compte pas contre
 * son livreur (`offre_en_attente` ignoré). Appli fermée : motif de clôture
 * `APPLI_FERMEE`.
 *
 * La joignabilité (socket ou jeton) ne garde que la création d'une offre :
 * une offre déjà partie garde ses relances et son échéance (décision du
 * client encore ouverte sur l'offre d'une appli non connectée).
 */
export function decisionRelance(
  course: EtatCourse | null | undefined,
  livreur: EtatLivreur | null | undefined,
  maintenant: Date,
): DecisionRelance {
  if (!courseChercheLivreur(course)) return { relancer: false, motif: 'COURSE_PLUS_EN_RECHERCHE' };
  if (!livreur) return { relancer: false, motif: 'LIVREUR_INDISPONIBLE', motif_livreur: 'INACTIF' };
  const d = peutRecevoirOffre({ ...livreur, offre_en_attente: false, joignable: true }, maintenant);
  if (!d.ok) {
    return {
      relancer: false,
      motif: d.motif === 'APPLI_FERMEE' ? 'APPLI_FERMEE' : 'LIVREUR_INDISPONIBLE',
      motif_livreur: d.motif,
    };
  }
  return { relancer: true };
}

// ============================================================
// AFFECTATION FORCÉE (admin)
// ============================================================

export type DecisionAffectationForcee =
  | {
      ok: true;
      /** Le livreur a déjà l'offre de CETTE course : nouvel envoi de la notification. */
      renvoi: boolean;
    }
  | { ok: false; motif: MotifRefusOffre };

/**
 * L'administrateur force l'affectation d'une course à un livreur : même règle
 * que la sélection automatique, joignabilité comprise (un livreur sans socket
 * ni jeton ne recevrait rien). Seule tolérance : une offre en attente pour
 * CETTE course (l'administrateur renvoie la notification).
 *
 * @param offresEnAttente  Courses des offres en attente du livreur.
 */
export function decisionAffectationForcee(
  livreur: Omit<EtatLivreur, 'offre_en_attente'>,
  offresEnAttente: { course_id: string }[],
  courseId: string,
  maintenant: Date,
): DecisionAffectationForcee {
  const autres = offresEnAttente.filter((o) => o.course_id !== courseId);
  const d = peutRecevoirOffre({ ...livreur, offre_en_attente: autres.length > 0 }, maintenant);
  if (!d.ok) return d;
  return { ok: true, renvoi: offresEnAttente.some((o) => o.course_id === courseId) };
}

// ============================================================
// ACCEPTATION
// ============================================================

export type DecisionAcceptation =
  | { ok: true }
  | { ok: false; motif: MotifRefusOffre; message: string };

/**
 * Le livreur peut-il prendre la course qu'il accepte ? La règle unique, sauf :
 *  - l'offre acceptée ne compte pas contre lui ;
 *  - « hors service », « appli fermée » et « injoignable » sont tolérés : il
 *    est là, son appli vient de répondre.
 * Message au livreur (tutoiement, comme l'appli).
 */
export function decisionAcceptation(livreur: EtatLivreur, maintenant: Date): DecisionAcceptation {
  const d = peutRecevoirOffre(
    {
      ...livreur,
      offre_en_attente: false,
      last_available_at: livreur.last_available_at ?? maintenant,
      appli_active: true,
      joignable: true,
    },
    maintenant,
  );
  if (d.ok) return d;
  return { ok: false, motif: d.motif, message: messageRefusAcceptation(d.motif, livreur, maintenant) };
}

function messageRefusAcceptation(
  motif: MotifRefusOffre,
  livreur: Pick<EtatLivreur, 'auto_pause_until'>,
  maintenant: Date,
): string {
  switch (motif) {
    case 'EN_PAUSE':
      return 'Tu es en pause : touche Reprendre pour recevoir des courses.';
    case 'PAUSE_AUTO':
      return livreur.auto_pause_until
        ? messagePauseAuto(livreur.auto_pause_until, maintenant)
        : 'Pause automatique.';
    case 'EN_COURSE':
      return 'Tu as déjà une course en cours.';
    case 'INACTIF':
      return "Ton compte livreur n'est pas actif.";
    default:
      return MESSAGE_COURSE_PLUS_DISPONIBLE;
  }
}
