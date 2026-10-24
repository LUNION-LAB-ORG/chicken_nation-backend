/**
 * Récupération confirmée sans code (conception du 24/10, 11.1) : règles pures.
 */
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { CourseStatut, DeliveryStatut, OrderStatus, UserRole, UserType } from '@prisma/client';

// Évaluation des `where` en mémoire, relations `some` et `notIn` comprises.
import { evaluer as correspond } from 'src/modules/deliverers/services/base-livreurs.simulee-spec';

import { MESSAGE_SANS_RESTAURANT, whereCourseARemettreParId, whereCoursesARemettre } from './code-retrait.rules';
import { journeeDeService } from './journee-service.rules';
import {
  MESSAGE_COURSE_AUTRE_RESTAURANT,
  MESSAGE_COURSE_CHANGEE,
  MESSAGE_COURSE_INTROUVABLE,
  MESSAGE_COURSE_SANS_LIVREUR,
  assertCourseDuRestaurant,
  commandesConfirmees,
  refusCourseHorsRemise,
} from './recuperation.rules';

const RESTO_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const RESTO_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MAINTENANT = new Date('2026-10-24T12:30:00.000Z');
const journee = journeeDeService(MAINTENANT);

describe('assertCourseDuRestaurant', () => {
  const compte = (role: UserRole, type: UserType, restaurant_id: string | null) => ({ id: 'u', role, type, restaurant_id });

  it('compte de restaurant : seulement les courses du sien', () => {
    expect(() => assertCourseDuRestaurant(compte(UserRole.CAISSIER, UserType.RESTAURANT, RESTO_A), RESTO_A)).not.toThrow();
    expect(() => assertCourseDuRestaurant(compte(UserRole.MANAGER, UserType.RESTAURANT, RESTO_B), RESTO_A)).toThrow(
      new ForbiddenException(MESSAGE_COURSE_AUTRE_RESTAURANT),
    );
  });

  it('rôle de restaurant sur un compte mal typé : même règle (comme la recherche par code)', () => {
    expect(() => assertCourseDuRestaurant(compte(UserRole.CAISSIER, UserType.BACKOFFICE, RESTO_B), RESTO_A)).toThrow(
      ForbiddenException,
    );
  });

  it('compte de restaurant sans restaurant : 403', () => {
    expect(() => assertCourseDuRestaurant(compte(UserRole.ASSISTANT_MANAGER, UserType.RESTAURANT, null), RESTO_A)).toThrow(
      new ForbiddenException(MESSAGE_SANS_RESTAURANT),
    );
  });

  it('compte du siège : tout le réseau', () => {
    expect(() => assertCourseDuRestaurant(compte(UserRole.ADMIN, UserType.BACKOFFICE, null), RESTO_A)).not.toThrow();
  });
});

describe('refusCourseHorsRemise', () => {
  const lue = (statut: CourseStatut, champs: Record<string, unknown> = {}) => ({
    statut,
    deliverer_id: 'koffi',
    turbo_escalated_at: null,
    created_at: new Date('2026-10-24T11:00:00.000Z'),
    ...champs,
  });

  it('créée hors de la journée de service (hier soir, avant 5 h) : 404', () => {
    expect(refusCourseHorsRemise(lue(CourseStatut.AT_RESTAURANT, { created_at: new Date('2026-10-24T04:59:00.000Z') }), journee)).toEqual(
      new NotFoundException(MESSAGE_COURSE_INTROUVABLE),
    );
  });

  it('en recherche sans livreur ni Turbo : personne à qui remettre', () => {
    expect(refusCourseHorsRemise(lue(CourseStatut.PENDING_ASSIGNMENT, { deliverer_id: null }), journee)).toEqual(
      new ConflictException(MESSAGE_COURSE_SANS_LIVREUR),
    );
  });

  it('déjà remise, terminée, annulée : le refus de la validation par code', () => {
    expect(refusCourseHorsRemise(lue(CourseStatut.IN_DELIVERY), journee)).toEqual(
      new ConflictException("Cette course vient d'être remise au livreur."),
    );
    expect(refusCourseHorsRemise(lue(CourseStatut.CANCELLED), journee)).toEqual(
      new ConflictException("Cette course vient d'être annulée : la remise n'est pas enregistrée."),
    );
  });
});

describe('commandesConfirmees', () => {
  const livraisons = [
    { statut: DeliveryStatut.PENDING, order: { id: 'o1' } },
    { statut: DeliveryStatut.PENDING, order: { id: 'o2' } },
    // Détachée de la course : plus une de ses commandes.
    { statut: DeliveryStatut.CANCELLED, order: { id: 'o3' } },
  ];

  it('commandes de la course : rendues sans doublon', () => {
    expect(commandesConfirmees(['o1', 'o2', 'o1'], livraisons)).toEqual(['o1', 'o2']);
  });

  it('une commande étrangère, détachée, ou aucune : 409, la caissière relit la fenêtre', () => {
    for (const ids of [['o1', 'o9'], ['o3'], []]) {
      expect(() => commandesConfirmees(ids, livraisons)).toThrow(new ConflictException(MESSAGE_COURSE_CHANGEE));
    }
  });
});

describe('whereCourseARemettreParId : même règle que le code (évaluée sur des courses en mémoire)', () => {
  const ceMatin = new Date('2026-10-24T09:00:00.000Z');
  const livraison = (status: OrderStatus, champs: Record<string, unknown> = {}) => ({
    statut: DeliveryStatut.PENDING,
    ajoutee_apres_retrait: false,
    order: { status },
    ...champs,
  });
  const courses = [
    { id: 'acceptee', statut: CourseStatut.ACCEPTED },
    { id: 'turbo', statut: CourseStatut.PENDING_ASSIGNMENT, turbo_escalated_at: ceMatin },
    { id: 'recherche', statut: CourseStatut.PENDING_ASSIGNMENT, turbo_escalated_at: null },
    { id: 'complement', statut: CourseStatut.IN_DELIVERY, parti_at: null, deliveries: [livraison(OrderStatus.READY, { ajoutee_apres_retrait: true })] },
    { id: 'partie-tout-remis', statut: CourseStatut.IN_DELIVERY, parti_at: ceMatin, deliveries: [livraison(OrderStatus.PICKED_UP)] },
    { id: 'sac-oublie', statut: CourseStatut.IN_DELIVERY, parti_at: ceMatin, deliveries: [livraison(OrderStatus.READY)] },
    { id: 'hier', statut: CourseStatut.ACCEPTED, created_at: new Date('2026-10-23T20:00:00.000Z') },
  ].map((c) => ({
    pickup_code: '421',
    restaurant_id: RESTO_A,
    turbo_escalated_at: null,
    parti_at: null,
    created_at: ceMatin,
    deliveries: [],
    ...c,
  }));

  it('retient exactement les courses que le code retrouverait', () => {
    for (const c of courses) {
      expect([c.id, correspond(c, whereCourseARemettreParId(c.id, journee))]).toEqual([
        c.id,
        correspond(c, whereCoursesARemettre('421', undefined, journee)),
      ]);
    }
    expect(courses.filter((c) => correspond(c, whereCourseARemettreParId(c.id, journee))).map((c) => c.id)).toEqual([
      'acceptee',
      'turbo',
      'complement',
      'sac-oublie',
    ]);
  });

  it('jamais une autre course que celle désignée', () => {
    expect(correspond(courses[0], whereCourseARemettreParId('turbo', journee))).toBe(false);
  });
});
