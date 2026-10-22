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
});

describe('decisionExpiration', () => {
  const libre = { pause_until: null, auto_pause_until: null };

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
});

describe('decisionAcceptation', () => {
  it('l’offre acceptée ne compte pas ; « hors service » est toléré (il vient de répondre)', () => {
    expect(decisionAcceptation(etat({ offre_en_attente: true, last_available_at: null }), MAINTENANT)).toEqual({
      ok: true,
    });
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
