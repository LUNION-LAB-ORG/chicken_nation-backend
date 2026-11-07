import { CourseStatut, DeliveryStatut, OrderStatus, OrderType } from '@prisma/client';

import { EtatLivreur } from 'src/modules/deliverers/helpers/disponibilite.rules';

import { messageSacChezLeLivreur } from './detachement-commande.rules';
import { refusLivreurRelance } from './relance-livraison.rules';
import { STATUTS_COMMANDE_REMISE, STATUTS_LIVRAISON_TERMINEE } from './remise-course.rules';
import { MESSAGE_COMMANDE_ANNULEE } from './sac-rapporte.rules';

/**
 * « AFFECTER À UN LIVREUR » (demande du 06/11), règles pures : le siège donne
 * une commande prête à un livreur précis, même déjà en course.
 *
 *  - il n'a aucune course : une course est créée pour lui, déjà acceptée ;
 *  - il va au restaurant ou y est : la commande rejoint sa course ;
 *  - il est déjà parti : elle rejoint sa tournée, comme un sac oublié (son
 *    appli le renvoie au restaurant une fois ses clients livrés) ;
 * Une course d'où vient la commande en perd la livraison, chez Turbo compris
 * (groupe annulé chez eux). Le sac déjà remis à un livreur ne change pas de main.
 */

export const MESSAGE_PAS_A_LIVRER = "Cette commande n'est pas à livrer.";
export const MESSAGE_PAS_ENCORE_PRETE = "Cette commande n'est pas encore prête : marquez-la prête, puis affectez-la.";
export const MESSAGE_DEJA_CHEZ_CE_LIVREUR = 'Cette commande est déjà dans la course de ce livreur.';
export const MESSAGE_AUTRE_RESTAURANT_LIVREUR = "Ce livreur n'est pas rattaché au restaurant de cette commande.";
export const MESSAGE_LIVREUR_AUTRE_RESTAURANT_EN_COURSE = 'Ce livreur est en course pour un autre restaurant.';

/** Raison de la clôture de l'offre en attente chez le livreur choisi, sans pénalité. */
export const RAISON_COMMANDE_AFFECTEE = 'COMMANDE_AFFECTEE';

/** Ce que les règles lisent de la commande. */
export interface CommandeAAffecter {
  status: OrderStatus;
  type: OrderType;
  delivery: {
    statut: DeliveryStatut;
    course: { deliverer_id: string | null };
  } | null;
}

/** La commande peut-elle aller à ce livreur ? `null` si oui, sinon le refus en clair. */
export function refusCommandeAAffecter(commande: CommandeAAffecter, delivererId: string): string | null {
  if (commande.type !== OrderType.DELIVERY) return MESSAGE_PAS_A_LIVRER;
  if (commande.status === OrderStatus.CANCELLED) return MESSAGE_COMMANDE_ANNULEE;
  if (STATUTS_COMMANDE_REMISE.includes(commande.status)) return messageSacChezLeLivreur(null);
  if (commande.status !== OrderStatus.READY) return MESSAGE_PAS_ENCORE_PRETE;
  const l = commande.delivery;
  if (l && !STATUTS_LIVRAISON_TERMINEE.includes(l.statut) && l.course.deliverer_id === delivererId) {
    return MESSAGE_DEJA_CHEZ_CE_LIVREUR;
  }
  return null;
}

/**
 * Le livreur peut-il la recevoir ? Même lecture que « Relancer la livraison » :
 * en course, seul un compte inactif refuse ; sans course, la pause, le hors
 * service et un téléphone injoignable refusent aussi. Appli fermée ou coupée,
 * en appel : jamais un refus (la notification part).
 *
 * @returns `null` si permis, sinon le refus en clair.
 */
export function refusLivreurAffectation(
  etat: (EtatLivreur & { restaurant_id?: string | null }) | null | undefined,
  enCourse: boolean,
  restaurantId: string,
  maintenant: Date,
): string | null {
  // Une course en livraison : la règle de la relance ne regarde plus que le compte.
  const refus = refusLivreurRelance(etat, enCourse ? [{ statut: CourseStatut.IN_DELIVERY }] : [], maintenant);
  if (refus) return refus.message;
  return etat?.restaurant_id === restaurantId ? null : MESSAGE_AUTRE_RESTAURANT_LIVREUR;
}

/** Texte rendu au siège après l'affectation. */
export function messageAffectation(p: {
  reference: string;
  prenom: string | null;
  nouvelle: boolean;
  statutCourse: CourseStatut;
  appliConnectee: boolean | null;
}): string {
  const livreur = p.prenom ?? 'ce livreur';
  const debut = p.nouvelle ? `${p.reference} affectée à ${livreur}` : `${p.reference} ajoutée à la course de ${livreur}`;
  const parti = !p.nouvelle && p.statutCourse === CourseStatut.IN_DELIVERY ? ', à récupérer au restaurant' : '';
  const notification = p.appliConnectee === false ? ', prévenu par notification' : '';
  return `${debut}${parti}${notification}.`;
}
