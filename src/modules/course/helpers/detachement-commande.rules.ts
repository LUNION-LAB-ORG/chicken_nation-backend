/**
 * COMMANDE À LIVRER PASSÉE À EMPORTER OU SUR PLACE, règles pures (demande du
 * client du 27/10 : « une commande à livrer qui est déjà groupée pour une
 * course et qui passe à emporter doit être retirée de la course »).
 *
 * Seul « Modifier la commande » (`PATCH /orders/:id`) change le type. Avant,
 * il n'écrivait que la commande : sa livraison restait dans la course, qui
 * cherchait toujours un livreur, et le livreur partait avec un sac que le
 * client venait chercher au comptoir.
 *
 * Désormais la livraison est retirée de sa course, comme une commande
 * détachée au départ du livreur (même suppression, mêmes annonces). Ce qui
 * décide :
 *  - commande déjà remise au livreur, ou livraison commencée : le sac est
 *    avec le livreur, le type ne change pas (409) ;
 *  - course confiée à Turbo : leur groupe est d'abord annulé chez eux ; un
 *    livreur Turbo déjà engagé, ou une réponse incertaine, refuse le
 *    changement de type ;
 *  - sinon (course sans livreur, proposée, acceptée, livreur au restaurant,
 *    ou course partie sans cette commande, restée au comptoir) : la livraison
 *    est retirée.
 * La commande n'est jamais annulée ; ses frais, son montant et ses paiements
 * suivent la règle habituelle du changement de type.
 */
import { CourseStatut, DeliveryStatut, OrderStatus, OrderType } from '@prisma/client';

import { STATUTS_COMMANDE_REMISE, STATUTS_LIVRAISON_TERMINEE } from './remise-course.rules';

/**
 * Course confiée à Turbo il y a moins de 30 s : l'envoi du groupe est peut-être
 * encore en route (jusqu'à 15 s pour le planificateur). Une annulation arrivée
 * avant lui répondrait « inconnue » et le groupe naîtrait ensuite chez Turbo.
 */
export const DELAI_ENVOI_TURBO_EN_COURS_MS = 30_000;

/** La commande quitte la livraison : à livrer avant, autre chose après. */
export function quitteLaLivraison(avant: OrderType, apres: OrderType | null | undefined): boolean {
  return avant === OrderType.DELIVERY && !!apres && apres !== OrderType.DELIVERY;
}

/** « à emporter », « sur place » : pour les messages. */
export function libelleNouveauType(type: OrderType): string {
  return type === OrderType.TABLE ? 'sur place' : 'à emporter';
}

export const messageSacChezLeLivreur = (type: OrderType): string =>
  `Le livreur a déjà récupéré cette commande : le sac est avec lui, elle ne peut plus passer ${libelleNouveauType(type)}.`;

export const messageLivreurTurboEngage = (type: OrderType): string =>
  `Un livreur Turbo a déjà accepté cette course : la commande ne peut plus passer ${libelleNouveauType(type)}.`;

export const MESSAGE_ENVOI_TURBO_EN_COURS = "La course vient d'être confiée à Turbo : réessayez dans un instant.";

export const MESSAGE_TURBO_INCERTAIN =
  "Turbo ne confirme pas l'annulation de la course : la commande reste à livrer, réessayez dans un instant.";

export const MESSAGE_COURSE_CHANGEE = 'La course de cette commande vient de changer : rechargez la commande et réessayez.';

/** Raison écrite sur la course vide annulée. */
export const raisonCourseVide = (reference: string, type: OrderType): string =>
  `Plus aucune commande à livrer : ${reference} passée ${libelleNouveauType(type)}`;

/** Raison écrite sur la course Turbo annulée quand il lui reste d'autres commandes, relancées. */
export const raisonCourseTurboRelancee = (reference: string, type: OrderType): string =>
  `${reference} passée ${libelleNouveauType(type)} : groupe annulé chez Turbo, les autres commandes repartent dans une nouvelle course`;

/** Raison écrite quand l'annulation chez Turbo a réussi mais que la commande n'a pas été modifiée. */
export const RAISON_TURBO_SANS_CHANGEMENT =
  'Groupe annulé chez Turbo, changement de type non enregistré : commandes relancées dans une nouvelle course';

/**
 * Cloche « Course annulée par Turbo » quand la relance des autres commandes
 * n'a pas pu se faire : leur groupe est mort chez Turbo, personne ne viendra.
 */
export const raisonRelanceImpossible = (reference: string, type: OrderType): string =>
  `groupe annulé après le passage de ${reference} ${libelleNouveauType(type)}, relance automatique impossible`;

/**
 * Ce que devient la course une fois la livraison retirée, décidé dans la
 * transaction du retrait (la course y est verrouillée) :
 *  - RETRAIT : il reste des commandes à livrer, la course continue ;
 *  - ANNULEE : plus rien à livrer ni de livré, la course est annulée (jamais
 *    la commande) ;
 *  - TERMINEE : plus rien à livrer mais des livraisons faites (course partie
 *    sans cette commande) : la course se termine comme après sa dernière
 *    livraison ;
 *  - TURBO_RELANCE : course confiée à Turbo, groupe annulé chez eux, avec
 *    d'autres commandes : la course est annulée, ses autres commandes
 *    repartent dans une nouvelle course.
 */
export type SuiteRetrait = 'RETRAIT' | 'ANNULEE' | 'TERMINEE' | 'TURBO_RELANCE';

export function suiteDuRetrait(p: {
  turbo: boolean;
  /** Livraisons encore à faire dans la course, commandes annulées exclues. */
  restantes: number;
  /** Livraisons déjà livrées ou en échec dans la course. */
  faites: number;
}): SuiteRetrait {
  if (p.turbo) return p.restantes > 0 ? 'TURBO_RELANCE' : 'ANNULEE';
  if (p.restantes > 0) return 'RETRAIT';
  return p.faites > 0 ? 'TERMINEE' : 'ANNULEE';
}

/** Ce qu'on lit de la livraison de la commande et de sa course. */
export interface LivraisonDeLaCommande {
  id: string;
  statut: DeliveryStatut;
  course: {
    id: string;
    statut: CourseStatut;
    deliverer_id: string | null;
    parti_at: Date | null;
    turbo_escalated_at: Date | null;
    /** Livraisons de la course : un livreur Turbo affecté se lit ici. */
    deliveries: { turbo_courier_id: string | null }[];
  };
}

/** Course sans livreur, proposée, avec un livreur interne ou confiée à Turbo. */
export type CasDetachement = 'SANS_LIVREUR' | 'AVEC_LIVREUR' | 'TURBO';

export type DecisionDetachement =
  | { action: 'RIEN' }
  | { action: 'REFUSER'; message: string }
  | { action: 'DETACHER'; cas: CasDetachement };

/** Statuts de course où la livraison peut encore être retirée (le reste est terminé). */
const STATUTS_COURSE_VIVANTE: CourseStatut[] = [
  CourseStatut.PENDING_ASSIGNMENT,
  CourseStatut.EXPIRED,
  CourseStatut.ACCEPTED,
  CourseStatut.AT_RESTAURANT,
  CourseStatut.IN_DELIVERY,
];

/**
 * Que faire de la livraison d'une commande à livrer qui passe à emporter ou
 * sur place.
 *
 *  - RIEN : pas de livraison, livraison terminée (livrée, échouée, annulée),
 *    course terminée, ou commande annulée (la course l'ignore déjà) ;
 *  - REFUSER : le sac est avec le livreur (commande remise, livraison
 *    commencée), ou un livreur Turbo est engagé ;
 *  - DETACHER : la livraison est retirée de la course. Course partie
 *    comprise : la commande est encore au comptoir (le livreur est parti
 *    sans elle) et le client vient la chercher.
 */
export function deciderDetachement(p: {
  statutCommande: OrderStatus;
  typeApres: OrderType;
  livraison: LivraisonDeLaCommande | null;
  maintenant: Date;
}): DecisionDetachement {
  const { livraison, typeApres } = p;
  if (!livraison) return { action: 'RIEN' };
  if (p.statutCommande === OrderStatus.CANCELLED) return { action: 'RIEN' };
  if (STATUTS_LIVRAISON_TERMINEE.includes(livraison.statut)) return { action: 'RIEN' };
  const course = livraison.course;
  if (!STATUTS_COURSE_VIVANTE.includes(course.statut)) return { action: 'RIEN' };

  if (STATUTS_COMMANDE_REMISE.includes(p.statutCommande) || livraison.statut !== DeliveryStatut.PENDING) {
    return { action: 'REFUSER', message: messageSacChezLeLivreur(typeApres) };
  }

  if (course.turbo_escalated_at) {
    const livreurTurbo =
      course.statut !== CourseStatut.PENDING_ASSIGNMENT || course.deliveries.some((d) => !!d.turbo_courier_id);
    if (livreurTurbo) return { action: 'REFUSER', message: messageLivreurTurboEngage(typeApres) };
    if (p.maintenant.getTime() - course.turbo_escalated_at.getTime() < DELAI_ENVOI_TURBO_EN_COURS_MS) {
      return { action: 'REFUSER', message: MESSAGE_ENVOI_TURBO_EN_COURS };
    }
    return { action: 'DETACHER', cas: 'TURBO' };
  }

  if (course.deliverer_id && course.statut !== CourseStatut.PENDING_ASSIGNMENT && course.statut !== CourseStatut.EXPIRED) {
    return { action: 'DETACHER', cas: 'AVEC_LIVREUR' };
  }
  return { action: 'DETACHER', cas: 'SANS_LIVREUR' };
}
