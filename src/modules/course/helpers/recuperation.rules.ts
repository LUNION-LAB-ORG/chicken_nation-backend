import { ConflictException, ForbiddenException, HttpException, NotFoundException } from '@nestjs/common';
import { CourseStatut, DeliveryStatut } from '@prisma/client';

import {
  ComptePersonnel,
  estCompteDeRestaurant,
} from 'src/modules/users/helpers/personnel-scope.helper';

import { MESSAGE_SANS_RESTAURANT } from './code-retrait.rules';
import { JourneeDeService } from './journee-service.rules';
import { messageValidationImpossible } from './remise-course.rules';

/**
 * RÉCUPÉRATION CONFIRMÉE SANS CODE (conception du 24/10, 11.1), règles pures.
 *
 * La caissière ne saisit plus le code : le livreur le lui dit, elle touche le
 * groupe de la course et confirme. Routes par identifiant :
 * `GET /courses/operations/:id` (aperçu) et
 * `POST /courses/operations/:id/recuperation` (`{ order_ids }`). Même règle
 * « à remettre » que la recherche par code (`whereCourseARemettreParId`), même
 * cœur de remise (`CourseActionService.remettreCourse`). Les routes à code
 * restent pour la caisse Sunmi et le repli de l'écran.
 */

export const MESSAGE_COURSE_INTROUVABLE = 'Course introuvable.';
export const MESSAGE_COURSE_AUTRE_RESTAURANT = "Cette course n'est pas celle de votre restaurant.";
export const MESSAGE_COURSE_SANS_LIVREUR = "Aucun livreur n'a encore accepté cette course.";
export const MESSAGE_COURSE_CHANGEE =
  "Cette course vient de changer : la remise n'est pas enregistrée, vérifiez les commandes et validez à nouveau.";

/**
 * Cloisonnement : un compte de restaurant (par son type ou son rôle, comme la
 * recherche par code) ne remet que les courses du sien. Compte du siège : tout
 * le réseau.
 */
export function assertCourseDuRestaurant(
  user: ComptePersonnel | undefined,
  restaurantIdCourse: string,
): void {
  if (!user || !estCompteDeRestaurant(user)) return;
  if (!user.restaurant_id) throw new ForbiddenException(MESSAGE_SANS_RESTAURANT);
  if (user.restaurant_id !== restaurantIdCourse) throw new ForbiddenException(MESSAGE_COURSE_AUTRE_RESTAURANT);
}

/** Ce que le refus lit de la course quand elle n'est plus à remettre. */
export interface CourseHorsRemise {
  statut: CourseStatut;
  deliverer_id: string | null;
  turbo_escalated_at: Date | null;
  created_at: Date;
}

/**
 * Refus d'une course qui n'est pas (ou plus) à remettre :
 *  - créée hors de la journée de service : 404, comme la recherche par code ;
 *  - encore en recherche, sans livreur ni Turbo : personne à qui remettre ;
 *  - sinon (déjà remise, partie, annulée) : le refus de la validation par code.
 */
export function refusCourseHorsRemise(course: CourseHorsRemise, journee: JourneeDeService): HttpException {
  const creee = course.created_at.getTime();
  if (creee < journee.debut.getTime() || creee >= journee.fin.getTime()) {
    return new NotFoundException(MESSAGE_COURSE_INTROUVABLE);
  }
  if (course.statut === CourseStatut.PENDING_ASSIGNMENT && !course.deliverer_id && !course.turbo_escalated_at) {
    return new ConflictException(MESSAGE_COURSE_SANS_LIVREUR);
  }
  return new ConflictException(messageValidationImpossible(course.statut));
}

/**
 * Commandes confirmées par la caissière : chacune doit être une commande de la
 * course (livraison non annulée). La fenêtre a pu être ouverte avant un
 * changement (commande retirée, déplacée dans une autre course) : 409, la
 * caissière relit la fenêtre. Doublons retirés.
 */
export function commandesConfirmees(
  orderIds: readonly string[],
  livraisons: readonly { statut: DeliveryStatut; order: { id: string } }[],
): string[] {
  const deLaCourse = new Set(
    livraisons.filter((l) => l.statut !== DeliveryStatut.CANCELLED).map((l) => l.order.id),
  );
  const ids = [...new Set(orderIds)];
  if (ids.length === 0 || ids.some((id) => !deLaCourse.has(id))) {
    throw new ConflictException(MESSAGE_COURSE_CHANGEE);
  }
  return ids;
}
