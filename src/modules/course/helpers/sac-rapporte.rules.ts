import { ConflictException, ForbiddenException, HttpException } from '@nestjs/common';
import { DeliveryFailureReason, DeliveryStatut, EntityStatus, OrderStatus, OrderType } from '@prisma/client';

import { ComptePersonnel, estCompteDeRestaurant } from 'src/modules/users/helpers/personnel-scope.helper';

/**
 * « SAC RAPPORTÉ » (demande du 28/10), règles pures.
 *
 * Après « Annuler » du livreur (27/10), la livraison est en échec et la
 * commande reste en livraison : le sac est chez le livreur. Quand il le
 * rapporte, la caisse (ou l'ADMIN au back office) touche « Sac rapporté » :
 * la commande redevient prête et repart dans une NOUVELLE course au passage
 * suivant du planificateur, qui n'est pas modifié.
 *
 * Une commande n'a qu'une livraison (`Delivery.order_id` unique) et le
 * planificateur ne prend qu'une commande sans livraison : la livraison
 * annulée est copiée au journal (`SAC_RAPPORTE`) puis supprimée, dans la
 * même transaction que le retour de la commande à « prête ».
 *
 * Sac à rapporter = commande à livrer, en livraison, pas supprimée,
 * livraison en échec, course non confiée à Turbo. Mêmes conditions pour le
 * geste (`POST /courses/operations/commandes/:orderId/sac-rapporte`), pour
 * `sac_a_rapporter` de `GET /orders/operations/active` et pour le rappel de
 * l'appli du livreur.
 */

export const MESSAGE_COMMANDE_INTROUVABLE = 'Commande introuvable.';
export const MESSAGE_COMMANDE_AUTRE_RESTAURANT = "Cette commande n'est pas celle de votre restaurant.";
export const MESSAGE_COMMANDE_ANNULEE = 'Commande annulée.';
export const MESSAGE_PAS_DE_SAC = 'Pas de sac à rapporter pour cette commande.';
/** Deux écritures de suite sans effet alors que le sac est encore à rapporter (cas limite). */
export const MESSAGE_COMMANDE_CHANGEE = 'Cette commande vient de changer : actualisez la liste.';

/** Raison de `course:statut:changed` de l'ancienne course (siège et restaurant). */
export const RAISON_SAC_RAPPORTE = 'SAC_RAPPORTE';

/** Notification du livreur quand la caisse confirme. */
export const TITRE_SAC_RENDU = 'Sac rendu';
export const corpsSacRendu = (reference: string): string => `${reference} · merci`;

/** Rappel de l'appli du livreur : ses sacs des dernières 24 h. */
export const SACS_A_RAPPORTER_FENETRE_MS = 24 * 60 * 60 * 1000;

type DateLue = Date | string | null | undefined;

const date = (v: DateLue): Date | null => {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

const iso = (v: DateLue): string | null => date(v)?.toISOString() ?? null;

/** Commande telle que lue (base, ou liste de l'écran Opérations). */
export interface CommandeSacLue {
  status?: string | null;
  type?: string | null;
  entity_status?: string | null;
  delivery?: {
    statut?: string | null;
    failed_at?: DateLue;
    failure_reason?: string | null;
    course?: {
      turbo_escalated_at?: DateLue;
      deliverer?: { id?: string | null; first_name?: string | null; last_name?: string | null } | null;
    } | null;
  } | null;
}

/** Le sac de cette commande est chez le livreur après « Annuler » : le geste est possible. */
export function estSacARapporter(c: CommandeSacLue | null | undefined): boolean {
  const l = c?.delivery;
  return (
    !!c &&
    c.status === OrderStatus.PICKED_UP &&
    c.type === OrderType.DELIVERY &&
    c.entity_status !== EntityStatus.DELETED &&
    !!l &&
    l.statut === DeliveryStatut.FAILED &&
    !!l.course &&
    !date(l.course.turbo_escalated_at)
  );
}

/** Champ `sac_a_rapporter` d'une commande de `GET /orders/operations/active`. */
export interface SacARapporter {
  livreur: { id: string; prenom: string | null; nom: string | null } | null;
  /** `failed_at` (ISO). */
  depuis: string | null;
  motif: DeliveryFailureReason | null;
}

/** `null` si la commande n'a pas de sac à rapporter. */
export function sacARapporterDe(c: CommandeSacLue | null | undefined): SacARapporter | null {
  if (!c || !estSacARapporter(c)) return null;
  const l = c.delivery!;
  const d = l.course?.deliverer;
  return {
    livreur: d?.id ? { id: d.id, prenom: d.first_name?.trim() || null, nom: d.last_name?.trim() || null } : null,
    depuis: iso(l.failed_at),
    motif: (l.failure_reason as DeliveryFailureReason | null | undefined) ?? null,
  };
}

/**
 * Cloisonnement : un compte de restaurant (sans restaurant, ou d'un autre)
 * ne rapporte que les sacs du sien. Compte du siège (ADMIN) : tout le réseau.
 */
export function assertCommandeDuRestaurant(user: ComptePersonnel | undefined, restaurantId: string): void {
  if (!user || !estCompteDeRestaurant(user)) return;
  if (!user.restaurant_id || user.restaurant_id !== restaurantId) {
    throw new ForbiddenException(MESSAGE_COMMANDE_AUTRE_RESTAURANT);
  }
}

/** Pas de sac à rapporter, et aucun geste déjà enregistré : 409, avec la raison. */
export function refusSansSac(status: string | null | undefined): HttpException {
  return new ConflictException(status === OrderStatus.CANCELLED ? MESSAGE_COMMANDE_ANNULEE : MESSAGE_PAS_DE_SAC);
}

/** Qui a touché « Sac rapporté » : la caisse (compte de restaurant) ou le siège. */
export function sourceDuGeste(user: ComptePersonnel | undefined): 'caisse' | 'admin' {
  return user && estCompteDeRestaurant(user) ? 'caisse' : 'admin';
}

/** Livraison annulée telle que lue avant sa suppression (jamais le code du client). */
export interface LivraisonAnnuleeLue {
  sequence_order: number;
  in_route_at: DateLue;
  arrived_at: DateLue;
  failed_at: DateLue;
  failure_note: string | null;
  customer_rating: number | null;
  customer_rating_note: string | null;
}

/**
 * `details` de la ligne SAC_RAPPORTE : la copie de la livraison supprimée
 * (le motif, le livreur, l'ancienne course et la commande sont dans les
 * colonnes de la ligne), et qui a touché le bouton.
 */
export function copieLivraisonAnnulee(p: {
  commande: string;
  course_reference: string;
  lot: string | null;
  livraison: LivraisonAnnuleeLue;
  par: { id: string | null; role: string | null };
}): Record<string, unknown> {
  const l = p.livraison;
  return {
    commande: p.commande,
    course_reference: p.course_reference,
    failed_at: iso(l.failed_at),
    failure_note: l.failure_note ?? null,
    in_route_at: iso(l.in_route_at),
    arrived_at: iso(l.arrived_at),
    sequence_order: l.sequence_order,
    customer_rating: l.customer_rating ?? null,
    customer_rating_note: l.customer_rating_note ?? null,
    // Lot de l'ancien regroupement (v1), effacé de la commande pour qu'elle reparte.
    lot: p.lot,
    par: p.par,
  };
}
