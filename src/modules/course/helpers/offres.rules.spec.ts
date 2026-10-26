/**
 * Règles des offres hors sélection automatique : expiration, relances,
 * affectation forcée et acceptation. Toutes passent par `peutRecevoirOffre`.
 */
import { CourseStatut, DelivererStatus, DeliveryService, EntityStatus } from '@prisma/client';

import { EtatLivreur, FIN_PAUSE_INDEFINIE } from 'src/modules/deliverers/helpers/disponibilite.rules';

import {
  MESSAGE_COURSE_PLUS_DISPONIBLE,
  courseChercheLivreur,
  decisionAcceptation,
  decisionAffectationForcee,
  decisionCreationOffre,
  decisionExpiration,
  decisionRelance,
  estCourseTurboDOrigine,
} from './offres.rules';

const MAINTENANT = new Date('2026-10-22T14:00:00.000Z');
const apres = (min: number) => new Date(MAINTENANT.getTime() + min * 60_000);
const avant = (min: number) => new Date(MAINTENANT.getTime() - min * 60_000);

const EN_RECHERCHE = { statut: CourseStatut.PENDING_ASSIGNMENT, turbo_escalated_at: null };

function etat(surcharge: Partial<EtatLivreur> = {}): EtatLivreur {
  return {
    status: DelivererStatus.ACTIVE,
    is_operational: true,
    entity_status: EntityStatus.ACTIVE,
    pause_until: null,
    auto_pause_until: null,
    last_available_at: avant(30),
    en_course: false,
    offre_en_attente: false,
    appli_active: true,
    ...surcharge,
  };
}

describe('courseChercheLivreur', () => {
  it('en recherche et pas chez Turbo, rien d’autre', () => {
    expect(courseChercheLivreur(EN_RECHERCHE)).toBe(true);
    expect(courseChercheLivreur({ ...EN_RECHERCHE, turbo_escalated_at: avant(1) })).toBe(false);
    for (const statut of [CourseStatut.ACCEPTED, CourseStatut.CANCELLED, CourseStatut.EXPIRED]) {
      expect(courseChercheLivreur({ statut, turbo_escalated_at: null })).toBe(false);
    }
    expect(courseChercheLivreur(null)).toBe(false);
  });
});

describe('estCourseTurboDOrigine', () => {
  const l = (delivery_service: DeliveryService) => ({ order: { delivery_service } });
  it('toutes les commandes livrées par Turbo : jamais d’offre interne', () => {
    expect(estCourseTurboDOrigine([l(DeliveryService.TURBO), l(DeliveryService.TURBO)])).toBe(true);
  });
  it('une commande interne, ou aucune livraison : course interne', () => {
    expect(estCourseTurboDOrigine([l(DeliveryService.TURBO), l(DeliveryService.CHICKEN_NATION)])).toBe(false);
    expect(estCourseTurboDOrigine([])).toBe(false);
  });
});

describe('decisionCreationOffre (sous le verrou du livreur)', () => {
  it('la règle unique ; seule une offre pour une AUTRE course compte ; le chaînage tolère « en course »', () => {
    expect(decisionCreationOffre(etat(), false, MAINTENANT)).toEqual({ ok: true });
    // L'offre de CETTE course (renvoi par l'administrateur) ne compte pas.
    expect(decisionCreationOffre(etat({ offre_en_attente: true }), false, MAINTENANT)).toEqual({ ok: true });
    expect(decisionCreationOffre(etat(), true, MAINTENANT)).toEqual({ ok: false, motif: 'OFFRE_EN_ATTENTE' });
    expect(decisionCreationOffre(etat({ pause_until: apres(10) }), false, MAINTENANT)).toEqual({
      ok: false,
      motif: 'EN_PAUSE',
    });
    expect(decisionCreationOffre(etat({ auto_pause_until: apres(5) }), false, MAINTENANT)).toEqual({
      ok: false,
      motif: 'PAUSE_AUTO',
    });
    expect(decisionCreationOffre(etat({ last_available_at: null }), false, MAINTENANT)).toEqual({
      ok: false,
      motif: 'HORS_SERVICE',
    });
    expect(decisionCreationOffre(etat({ en_course: true }), false, MAINTENANT)).toEqual({
      ok: false,
      motif: 'EN_COURSE',
    });
    expect(decisionCreationOffre(etat({ en_course: true }), false, MAINTENANT, true)).toEqual({ ok: true });
    expect(decisionCreationOffre(etat({ en_course: true, pause_until: apres(10) }), false, MAINTENANT, true)).toEqual({
      ok: false,
      motif: 'EN_PAUSE',
    });
    expect(decisionCreationOffre(null, false, MAINTENANT)).toEqual({ ok: false, motif: 'INACTIF' });
  });

  it('appli fermée (24/10) : aucune offre, quelle qu’en soit la source', () => {
    const fermee = { appli_active: false, appli_fermee_prouvee: true };
    expect(decisionCreationOffre(etat(fermee), false, MAINTENANT)).toEqual({
      ok: false,
      motif: 'APPLI_FERMEE',
    });
    // Renvoi de l'offre de CETTE course par l'administrateur : refusé aussi.
    expect(decisionCreationOffre(etat({ ...fermee, offre_en_attente: true }), false, MAINTENANT)).toEqual({
      ok: false,
      motif: 'APPLI_FERMEE',
    });
  });

  it('connexion coupée (25/10) : aucune offre non plus, motif CONNEXION_COUPEE', () => {
    expect(decisionCreationOffre(etat({ appli_active: false }), false, MAINTENANT)).toEqual({
      ok: false,
      motif: 'CONNEXION_COUPEE',
    });
  });
});

describe('decisionExpiration', () => {
  const libre = { pause_until: null, auto_pause_until: null, appli_active: true };

  it('offre ignorée, course toujours en recherche : pénalité', () => {
    expect(decisionExpiration(EN_RECHERCHE, libre, MAINTENANT)).toEqual({ penaliser: true });
  });

  it('course acceptée, fusionnée, annulée ou confiée à Turbo entre-temps : aucune pénalité', () => {
    for (const course of [
      { statut: CourseStatut.ACCEPTED, turbo_escalated_at: null },
      { statut: CourseStatut.CANCELLED, turbo_escalated_at: null },
      { ...EN_RECHERCHE, turbo_escalated_at: avant(1) },
      null,
    ]) {
      expect(decisionExpiration(course, libre, MAINTENANT)).toEqual({
        penaliser: false,
        raison: 'COURSE_PLUS_EN_RECHERCHE',
      });
    }
  });

  it('livreur passé en pause (ou pause automatique) entre-temps : aucune pénalité ; pause échue : pénalité', () => {
    expect(decisionExpiration(EN_RECHERCHE, { ...libre, pause_until: FIN_PAUSE_INDEFINIE }, MAINTENANT)).toEqual({
      penaliser: false,
      raison: 'LIVREUR_EN_PAUSE',
    });
    expect(decisionExpiration(EN_RECHERCHE, { ...libre, auto_pause_until: apres(10) }, MAINTENANT)).toEqual({
      penaliser: false,
      raison: 'LIVREUR_EN_PAUSE',
    });
    expect(decisionExpiration(EN_RECHERCHE, { ...libre, pause_until: MAINTENANT }, MAINTENANT)).toEqual({
      penaliser: true,
    });
  });

  it('appli du livreur fermée (24/10) ou connexion coupée (25/10) : aucune pénalité, il n’a pas pu voir l’offre', () => {
    for (const appli_fermee_prouvee of [true, false, undefined]) {
      const silencieux = { ...libre, appli_active: false, appli_fermee_prouvee };
      expect(decisionExpiration(EN_RECHERCHE, silencieux, MAINTENANT)).toEqual({
        penaliser: false,
        raison: 'APPLI_FERMEE',
      });
    }
  });

  it('priorités : course disparue, puis pause, puis appli fermée', () => {
    const ferme = { ...libre, appli_active: false };
    expect(decisionExpiration({ ...EN_RECHERCHE, turbo_escalated_at: avant(1) }, ferme, MAINTENANT)).toEqual({
      penaliser: false,
      raison: 'COURSE_PLUS_EN_RECHERCHE',
    });
    expect(decisionExpiration(EN_RECHERCHE, { ...ferme, pause_until: apres(5) }, MAINTENANT)).toEqual({
      penaliser: false,
      raison: 'LIVREUR_EN_PAUSE',
    });
  });
});

describe('decisionRelance', () => {
  it('livreur toujours disponible : relance ; son offre relancée ne compte pas contre lui', () => {
    expect(decisionRelance(EN_RECHERCHE, etat({ offre_en_attente: true }), MAINTENANT)).toEqual({ relancer: true });
  });

  it('livreur passé en pause, en pause automatique, hors service, en course ou inactif : offre close', () => {
    const cas: [Partial<EtatLivreur>, string][] = [
      [{ pause_until: FIN_PAUSE_INDEFINIE }, 'EN_PAUSE'],
      [{ auto_pause_until: apres(20) }, 'PAUSE_AUTO'],
      [{ last_available_at: null }, 'HORS_SERVICE'],
      [{ en_course: true }, 'EN_COURSE'],
      [{ is_operational: false }, 'INACTIF'],
    ];
    for (const [surcharge, motif] of cas) {
      expect(decisionRelance(EN_RECHERCHE, etat(surcharge), MAINTENANT)).toEqual({
        relancer: false,
        motif: 'LIVREUR_INDISPONIBLE',
        motif_livreur: motif,
      });
    }
  });

  it('course plus en recherche : offre close, sans regarder le livreur', () => {
    expect(
      decisionRelance({ ...EN_RECHERCHE, turbo_escalated_at: avant(1) }, etat(), MAINTENANT),
    ).toEqual({ relancer: false, motif: 'COURSE_PLUS_EN_RECHERCHE' });
  });

  it('appli du livreur fermée (24/10) : offre close avec le motif APPLI_FERMEE', () => {
    expect(decisionRelance(EN_RECHERCHE, etat({ appli_active: false, appli_fermee_prouvee: true }), MAINTENANT)).toEqual({
      relancer: false,
      motif: 'APPLI_FERMEE',
      motif_livreur: 'APPLI_FERMEE',
    });
  });

  it('connexion coupée (25/10) : offre close de la même façon (APPLI_FERMEE, sans pénalité), jamais « livreur indisponible »', () => {
    expect(decisionRelance(EN_RECHERCHE, etat({ appli_active: false }), MAINTENANT)).toEqual({
      relancer: false,
      motif: 'APPLI_FERMEE',
      motif_livreur: 'CONNEXION_COUPEE',
    });
  });

  it('pause et appli fermée : la pause est dite d’abord (LIVREUR_INDISPONIBLE)', () => {
    expect(
      decisionRelance(EN_RECHERCHE, etat({ appli_active: false, pause_until: FIN_PAUSE_INDEFINIE }), MAINTENANT),
    ).toEqual({ relancer: false, motif: 'LIVREUR_INDISPONIBLE', motif_livreur: 'EN_PAUSE' });
  });
});

describe('decisionAffectationForcee', () => {
  const { offre_en_attente: _o, ...libre } = etat();

  it('livreur disponible : envoi ; offre déjà en attente pour CETTE course : renvoi', () => {
    expect(decisionAffectationForcee(libre, [], 'c1', MAINTENANT)).toEqual({ ok: true, renvoi: false });
    expect(decisionAffectationForcee(libre, [{ course_id: 'c1' }], 'c1', MAINTENANT)).toEqual({
      ok: true,
      renvoi: true,
    });
  });

  it('offre en attente pour une AUTRE course : refus OFFRE_EN_ATTENTE', () => {
    expect(decisionAffectationForcee(libre, [{ course_id: 'c2' }], 'c1', MAINTENANT)).toEqual({
      ok: false,
      motif: 'OFFRE_EN_ATTENTE',
    });
  });

  it('en pause, pause automatique, hors service, en course : refus avec le motif de la règle', () => {
    expect(decisionAffectationForcee({ ...libre, pause_until: apres(32) }, [], 'c1', MAINTENANT)).toEqual({
      ok: false,
      motif: 'EN_PAUSE',
    });
    expect(decisionAffectationForcee({ ...libre, auto_pause_until: apres(5) }, [], 'c1', MAINTENANT)).toEqual({
      ok: false,
      motif: 'PAUSE_AUTO',
    });
    expect(decisionAffectationForcee({ ...libre, last_available_at: null }, [], 'c1', MAINTENANT)).toEqual({
      ok: false,
      motif: 'HORS_SERVICE',
    });
    expect(decisionAffectationForcee({ ...libre, en_course: true }, [], 'c1', MAINTENANT)).toEqual({
      ok: false,
      motif: 'EN_COURSE',
    });
  });

  it('connexion coupée (25/10) : refus CONNEXION_COUPEE', () => {
    expect(decisionAffectationForcee({ ...libre, appli_active: false }, [], 'c1', MAINTENANT)).toEqual({
      ok: false,
      motif: 'CONNEXION_COUPEE',
    });
  });

  it('appli fermée (24/10) : refus APPLI_FERMEE, même pour renvoyer l’offre de CETTE course', () => {
    const ferme = { ...libre, appli_active: false, appli_fermee_prouvee: true };
    expect(decisionAffectationForcee(ferme, [], 'c1', MAINTENANT)).toEqual({ ok: false, motif: 'APPLI_FERMEE' });
    expect(decisionAffectationForcee(ferme, [{ course_id: 'c1' }], 'c1', MAINTENANT)).toEqual({
      ok: false,
      motif: 'APPLI_FERMEE',
    });
  });
});

describe('decisionAcceptation', () => {
  it('l’offre acceptée ne compte pas ; « hors service » est toléré (il vient de répondre)', () => {
    expect(decisionAcceptation(etat({ offre_en_attente: true, last_available_at: null }), MAINTENANT)).toEqual({
      ok: true,
    });
  });

  it('« appli fermée » est toléré : son appli vient de répondre', () => {
    expect(decisionAcceptation(etat({ offre_en_attente: true, appli_active: false }), MAINTENANT)).toEqual({ ok: true });
  });

  it('déjà en course, en pause, en pause automatique, inactif : refus, message au livreur (tutoiement)', () => {
    expect(decisionAcceptation(etat({ en_course: true }), MAINTENANT)).toEqual({
      ok: false,
      motif: 'EN_COURSE',
      message: 'Tu as déjà une course en cours.',
    });
    expect(decisionAcceptation(etat({ pause_until: FIN_PAUSE_INDEFINIE }), MAINTENANT)).toEqual({
      ok: false,
      motif: 'EN_PAUSE',
      message: 'Tu es en pause : touche Reprendre pour recevoir des courses.',
    });
    expect(decisionAcceptation(etat({ auto_pause_until: new Date('2026-10-22T14:32:00.000Z') }), MAINTENANT)).toEqual({
      ok: false,
      motif: 'PAUSE_AUTO',
      message: "Pause automatique jusqu'à 14 h 32.",
    });
    expect(decisionAcceptation(etat({ status: DelivererStatus.SUSPENDED }), MAINTENANT)).toEqual({
      ok: false,
      motif: 'INACTIF',
      message: "Ton compte livreur n'est pas actif.",
    });
  });

  it('les textes ne contiennent ni tiret cadratin ni valeur d’énumération', () => {
    expect(MESSAGE_COURSE_PLUS_DISPONIBLE).toBe("Cette course n'est plus disponible.");
    expect(MESSAGE_COURSE_PLUS_DISPONIBLE).not.toMatch(/—/);
  });
});

/**
 * Livreur injoignable (ni socket ni jeton) : seule la CRÉATION d'une offre le
 * passe. Une offre déjà partie garde ses relances, son échéance et sa
 * pénalité (décision du client encore ouverte), et l'acceptation reste permise.
 */
describe('injoignable : seule la création d’une offre est gardée', () => {
  const injoignable = etat({ joignable: false });

  it('création (sélection, planificateur) : refusée, INJOIGNABLE', () => {
    expect(decisionCreationOffre(injoignable, false, MAINTENANT)).toEqual({ ok: false, motif: 'INJOIGNABLE' });
    expect(decisionCreationOffre(etat({ joignable: true }), false, MAINTENANT)).toEqual({ ok: true });
  });

  it('affectation forcée : refusée, INJOIGNABLE (même règle que la sélection)', () => {
    expect(decisionAffectationForcee(injoignable, [], 'c1', MAINTENANT)).toEqual({ ok: false, motif: 'INJOIGNABLE' });
  });

  it('relance d’une offre déjà partie : envoyée comme avant', () => {
    expect(decisionRelance(EN_RECHERCHE, injoignable, MAINTENANT)).toEqual({ relancer: true });
  });

  it('échéance d’une offre déjà partie : pénalité inchangée', () => {
    expect(decisionExpiration(EN_RECHERCHE, injoignable, MAINTENANT)).toEqual({ penaliser: true });
  });

  it('acceptation : permise (son appli vient de répondre)', () => {
    expect(decisionAcceptation(injoignable, MAINTENANT)).toEqual({ ok: true });
  });
});

/**
 * Livreur en appel avec le service client (relecture du 24/10) : l'écran
 * d'appel recouvre tout. Seule la CRÉATION d'une offre le passe ; une offre
 * déjà partie garde ses relances et son échéance, et l'écran d'appel la montre
 * avec Accepter.
 */
describe('en appel : seule la création d’une offre est gardée', () => {
  const enAppel = etat({ en_appel: true });

  it('création (sélection, planificateur, dernier contrôle) : refusée, EN_APPEL', () => {
    expect(decisionCreationOffre(enAppel, false, MAINTENANT)).toEqual({ ok: false, motif: 'EN_APPEL' });
    expect(decisionCreationOffre(etat({ en_appel: false }), false, MAINTENANT)).toEqual({ ok: true });
  });

  it('affectation forcée : refusée, EN_APPEL (même règle que la sélection)', () => {
    expect(decisionAffectationForcee(enAppel, [], 'c1', MAINTENANT)).toEqual({ ok: false, motif: 'EN_APPEL' });
  });

  it('relance d’une offre déjà partie : envoyée comme avant', () => {
    expect(decisionRelance(EN_RECHERCHE, enAppel, MAINTENANT)).toEqual({ relancer: true });
  });

  it('échéance d’une offre déjà partie : pénalité inchangée', () => {
    expect(decisionExpiration(EN_RECHERCHE, enAppel, MAINTENANT)).toEqual({ penaliser: true });
  });

  it('acceptation : permise (depuis l’écran d’appel)', () => {
    expect(decisionAcceptation(enAppel, MAINTENANT)).toEqual({ ok: true });
  });
});
