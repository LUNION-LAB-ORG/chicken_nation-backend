import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { CourseStatut, OrderStatus, Prisma } from '@prisma/client';

import {
  ComptePersonnel,
  estCompteDeRestaurant,
} from 'src/modules/users/helpers/personnel-scope.helper';

import { JourneeDeService } from './journee-service.rules';

/**
 * CODE DE RETRAIT : 3 chiffres dictés par le livreur à la caisse.
 *
 * Incident du 22/10 : le code était tiré au hasard sur tout le réseau, et la
 * caisse le cherchait dans tous les restaurants, tous jours confondus. Une
 * course d'un AUTRE restaurant portait le même code : la caisse est tombée
 * dessus et a refusé le retrait (« commande pas prête ») alors que la bonne
 * commande l'était.
 *
 * Règles depuis :
 *  - GÉNÉRATION : un code libre parmi les courses du même restaurant créées
 *    pendant la journée de service, tous statuts confondus, tiré au hasard
 *    sous verrou (`CourseHelper.genererCodeRetrait`) ;
 *  - RECHERCHE : seulement les courses à remettre du restaurant concerné,
 *    créées pendant la journée de service en cours.
 *
 * La longueur ne change pas : Turbo et la caisse Sunmi l'utilisent.
 */

export const NOMBRE_CODES_RETRAIT = 1000;

/** Les 1 000 codes, de « 000 » à « 999 ». */
export const TOUS_LES_CODES_RETRAIT: readonly string[] = Array.from(
  { length: NOMBRE_CODES_RETRAIT },
  (_, n) => n.toString().padStart(3, '0'),
);

/** Une course qui ne reviendra jamais au comptoir. */
export const STATUTS_COURSE_TERMINEE: CourseStatut[] = [
  CourseStatut.COMPLETED,
  CourseStatut.CANCELLED,
  CourseStatut.EXPIRED,
];

/** Ce que la génération lit des courses du jour du restaurant. */
export interface CodeDuJour {
  pickup_code: string;
  statut: CourseStatut;
}

export interface ChoixCodeRetrait {
  code: string;
  /**
   * `null` : code libre (cas normal).
   * Les 1 000 codes ont déjà servi aujourd'hui dans ce restaurant (improbable) :
   *  - `CODE_DE_COURSE_TERMINEE` : réutilise le code d'une course terminée. La
   *    recherche ne voit que les courses à remettre : elle reste sans ambiguïté ;
   *  - `CODE_EN_COURS` : plus de 1 000 courses en cours à la fois, la caisse
   *    verra un doublon et le signalera au lieu de choisir.
   */
  repli: null | 'CODE_DE_COURSE_TERMINEE' | 'CODE_EN_COURS';
}

function auHasard(codes: readonly string[], aleatoire: () => number): string {
  const index = Math.floor(aleatoire() * codes.length);
  return codes[Math.min(Math.max(index, 0), codes.length - 1)];
}

/**
 * Choisit le code d'une nouvelle course, au hasard parmi les codes libres du
 * restaurant pour la journée de service. Règle pure : le verrou et la lecture
 * sont dans `CourseHelper.genererCodeRetrait`.
 */
export function choisirCodeRetrait(
  codesDuJour: CodeDuJour[],
  aleatoire: () => number = Math.random,
): ChoixCodeRetrait {
  const pris = new Set(codesDuJour.map((c) => c.pickup_code));
  const libres = TOUS_LES_CODES_RETRAIT.filter((code) => !pris.has(code));
  if (libres.length > 0) return { code: auHasard(libres, aleatoire), repli: null };

  const enCours = new Set(
    codesDuJour
      .filter((c) => !STATUTS_COURSE_TERMINEE.includes(c.statut))
      .map((c) => c.pickup_code),
  );
  const reutilisables = TOUS_LES_CODES_RETRAIT.filter((code) => !enCours.has(code));
  if (reutilisables.length > 0) {
    return { code: auHasard(reutilisables, aleatoire), repli: 'CODE_DE_COURSE_TERMINEE' };
  }
  return { code: auHasard(TOUS_LES_CODES_RETRAIT, aleatoire), repli: 'CODE_EN_COURS' };
}

/**
 * Courses qu'une caisse peut remettre avec ce code :
 *  - acceptées par un livreur interne (ACCEPTED, AT_RESTAURANT) ;
 *  - confiées à Turbo et encore PENDING_ASSIGNMENT : leur livreur peut se
 *    présenter avant que leurs webhooks n'aient fait avancer la course, la
 *    caisse ne doit pas être bloquée par un webhook en retard ;
 * du restaurant concerné (tous si `restaurantId` est absent), créées pendant
 * la journée de service. Une course d'hier restée active est ignorée.
 */
export function whereCoursesARemettre(
  code: string,
  restaurantId: string | undefined,
  journee: JourneeDeService,
): Prisma.CourseWhereInput {
  return {
    pickup_code: code,
    ...(restaurantId ? { restaurant_id: restaurantId } : {}),
    created_at: { gte: journee.debut, lt: journee.fin },
    OR: [
      { statut: { in: [CourseStatut.ACCEPTED, CourseStatut.AT_RESTAURANT] } },
      { statut: CourseStatut.PENDING_ASSIGNMENT, turbo_escalated_at: { not: null } },
    ],
  };
}

export const MESSAGE_SANS_RESTAURANT =
  "Votre compte n'est rattaché à aucun restaurant : impossible de remettre une course.";
export const MESSAGE_AUTRE_RESTAURANT =
  'Vous ne pouvez remettre que les courses de votre restaurant.';

/**
 * Restaurant où chercher le code :
 *  - compte de restaurant (caissière, manager…) : TOUJOURS le sien, même si
 *    rien n'est envoyé (la caisse Sunmi n'envoie que le code). Un autre
 *    restaurant demandé est refusé ;
 *  - compte du siège (ADMIN…) : celui demandé, ou tous s'il n'en demande pas.
 */
export function restaurantDuRetrait(
  user: ComptePersonnel | undefined,
  restaurantDemande?: string,
): string | undefined {
  if (user && estCompteDeRestaurant(user)) {
    if (!user.restaurant_id) throw new ForbiddenException(MESSAGE_SANS_RESTAURANT);
    if (restaurantDemande && restaurantDemande !== user.restaurant_id) {
      throw new ForbiddenException(MESSAGE_AUTRE_RESTAURANT);
    }
    return user.restaurant_id;
  }
  return restaurantDemande || undefined;
}

export const MESSAGE_CODE_INTROUVABLE =
  "Aucune course en cours avec ce code dans ce restaurant aujourd'hui. Vérifiez le code dicté par le livreur.";
export const MESSAGE_CODE_INTROUVABLE_RESEAU =
  "Aucune course en cours avec ce code aujourd'hui. Vérifiez le code dicté par le livreur.";
export const MESSAGE_CODE_PLUSIEURS_RESTAURANTS =
  'Ce code existe dans plusieurs restaurants : choisissez le restaurant.';
export const MESSAGE_CODE_EN_DOUBLE =
  "Plusieurs courses en cours portent ce code dans ce restaurant aujourd'hui : prévenez un administrateur.";

/**
 * Doublon dans un même restaurant : les références des courses sont données
 * pour que l'administrateur annule la mauvaise (sa relance reçoit un code
 * libre).
 */
export function messageCodeEnDouble(references: string[]): string {
  const connues = references.filter(Boolean);
  if (connues.length === 0) return MESSAGE_CODE_EN_DOUBLE;
  return `Plusieurs courses en cours portent ce code dans ce restaurant aujourd'hui (${enumerer(connues)}) : prévenez un administrateur.`;
}

/**
 * La course à remettre parmi celles trouvées. Jamais de choix au hasard : se
 * tromper de course, c'est remettre les plats d'un autre client.
 *  - aucune : 404 ;
 *  - une : c'est elle ;
 *  - plusieurs restaurants (compte du siège sans restaurant choisi) : 409 ;
 *  - plusieurs dans le même restaurant : 409. Ne peut venir que des courses
 *    créées avant la règle d'unicité, le jour de sa mise en service.
 */
export function retenirCourseARemettre<T extends { restaurant_id: string; reference?: string }>(
  courses: T[],
  restaurantId: string | undefined,
): T {
  if (courses.length === 0) {
    throw new NotFoundException(
      restaurantId ? MESSAGE_CODE_INTROUVABLE : MESSAGE_CODE_INTROUVABLE_RESEAU,
    );
  }
  if (courses.length === 1) return courses[0];
  const restaurants = new Set(courses.map((c) => c.restaurant_id));
  throw new ConflictException(
    restaurants.size > 1
      ? MESSAGE_CODE_PLUSIEURS_RESTAURANTS
      : messageCodeEnDouble(courses.map((c) => c.reference ?? '')),
  );
}

/** Statut d'une commande, avec les mots de la page Commandes du backoffice. */
export const LIBELLES_STATUT_COMMANDE: Record<OrderStatus, string> = {
  PENDING: 'En attente',
  ACCEPTED: 'Nouvelle',
  IN_PROGRESS: 'En préparation',
  READY: 'Prête',
  PICKED_UP: 'En livraison',
  COLLECTED: 'Récupérée',
  COMPLETED: 'Terminée',
  CANCELLED: 'Annulée',
};

/** Statuts d'une commande qui deviendra prête : il suffit d'attendre la cuisine. */
const STATUTS_AVANT_PRETE: OrderStatus[] = [
  OrderStatus.PENDING,
  OrderStatus.ACCEPTED,
  OrderStatus.IN_PROGRESS,
];

function enumerer(elements: string[]): string {
  if (elements.length <= 1) return elements.join('');
  return `${elements.slice(0, -1).join(', ')} et ${elements[elements.length - 1]}`;
}

/**
 * Message de refus quand des commandes de la course ne sont pas prêtes : la
 * caissière doit savoir LAQUELLE et où elle en est.
 */
export function messageCommandesPasPretes(
  commandes: { reference: string; status: OrderStatus }[],
): string {
  const toutesAvantPrete = commandes.every((c) => STATUTS_AVANT_PRETE.includes(c.status));
  if (commandes.length === 1) {
    const [c] = commandes;
    const libelle = LIBELLES_STATUT_COMMANDE[c.status] ?? c.status;
    return toutesAvantPrete
      ? `La commande ${c.reference} est encore « ${libelle} » : marquez-la prête avant de la remettre.`
      : `La commande ${c.reference} est « ${libelle} » : elle ne peut pas être remise au livreur.`;
  }
  const liste = enumerer(
    commandes.map((c) => `${c.reference} (« ${LIBELLES_STATUT_COMMANDE[c.status] ?? c.status} »)`),
  );
  return toutesAvantPrete
    ? `Les commandes ${liste} ne sont pas encore prêtes : marquez-les prêtes avant de les remettre.`
    : `Les commandes ${liste} ne sont pas prêtes : elles ne peuvent pas être remises au livreur.`;
}
