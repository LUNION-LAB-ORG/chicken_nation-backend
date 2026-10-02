import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EntityStatus, OrderStatus, User } from '@prisma/client';
import { assertCanAccessRestaurant } from 'src/modules/order/helpers/restaurant-scope.helper';

/**
 * Tolérance d'arrondi (FCFA) entre le cumul des paiements SUCCESS et le total de
 * la commande. Absorbe l'écart de taxe app/back (≈ ±50 : l'app arrondit la taxe
 * au plancher de 50, le back au plafond de 10). Au-delà, la commande n'est PAS
 * considérée comme payée (paiement-jeton ou sous-paiement). cf. réconciliation KKiaPay.
 */
export const PAYMENT_AMOUNT_TOLERANCE = 50;

/** Ce que la caisse et le back office envoient, ligne par ligne. */
export interface LigneEncaissement {
  amount: number;
  order_id?: string;
}

/**
 * Vérifie qu'un encaissement porte sur UNE commande et garde les lignes qui
 * ont un montant.
 *
 * Les deux écrans qui appellent POST /paiements/add (caisse et back office)
 * mettent le même `order_id` sur chaque ligne. Une ligne sans commande créait
 * un paiement SUCCESS orphelin, qu'une commande de l'application pouvait
 * ensuite consommer ; plusieurs commandes dans un même appel n'en recalculaient
 * qu'une.
 *
 * Les lignes à zéro sont ignorées sans erreur : la caisse en envoie une quand
 * elle ajoute un moyen de paiement alors que tout est déjà réparti.
 */
export function extraireEncaissement<L extends LigneEncaissement>(
  lignes: L[],
): { orderId: string; lignes: L[] } {
  if (!lignes || lignes.length === 0) {
    throw new BadRequestException('Aucun paiement à ajouter');
  }
  const commandes = new Set(lignes.map((ligne) => ligne.order_id ?? ''));
  if (commandes.has('')) {
    throw new BadRequestException(
      'Chaque paiement doit indiquer la commande encaissée.',
    );
  }
  if (commandes.size > 1) {
    throw new BadRequestException(
      'Un encaissement ne porte que sur une seule commande.',
    );
  }
  const [orderId] = [...commandes];
  return { orderId, lignes: lignes.filter((ligne) => ligne.amount > 0) };
}

/** Ce qu'il faut savoir d'une commande pour décider si on peut l'encaisser. */
export interface CommandeAEncaisser {
  restaurant_id: string | null;
  status: OrderStatus;
  entity_status: EntityStatus;
}

/**
 * Refuse d'encaisser une commande supprimée, annulée, ou qui appartient à un
 * autre restaurant que celui du compte.
 *
 * ⚠️ Le contrôle du restaurant manquait : un compte du restaurant A
 * enregistrait un paiement sur la commande du restaurant B, la marquait payée
 * et la terminait. Il passe AVANT le contrôle du statut, pour ne rien
 * apprendre d'une commande étrangère. Sans effet pour un compte du back office.
 */
export function verifierCommandeEncaissable<C extends CommandeAEncaisser>(
  commande: C | null | undefined,
  user: User | undefined,
): C {
  if (!commande || commande.entity_status === EntityStatus.DELETED) {
    throw new NotFoundException('Commande introuvable');
  }
  assertCanAccessRestaurant(user, commande.restaurant_id);
  if (commande.status === OrderStatus.CANCELLED) {
    throw new BadRequestException(
      'Commande annulée : elle ne peut pas être encaissée.',
    );
  }
  return commande;
}

/**
 * La commande est-elle soldée, et faut-il la terminer ?
 *
 * Soldée quand le cumul des paiements SUCCESS couvre le montant, à la
 * tolérance près. Un encaissement partiel ne la rend pas « payée » : elle garde
 * un reste dû (leçon KKiaPay, même règle que la confirmation d'un encaissement
 * livreur). Terminée seulement si elle était déjà remise au client.
 */
export function etatApresEncaissement(
  montantCommande: number,
  totalEncaisse: number,
  statut: OrderStatus,
): { soldee: boolean; aTerminer: boolean } {
  const soldee = totalEncaisse >= montantCommande - PAYMENT_AMOUNT_TOLERANCE;
  return { soldee, aTerminer: soldee && statut === OrderStatus.COLLECTED };
}

/** Ce qu'il faut savoir d'un paiement réussi pour repérer un paiement reçu deux fois. */
export interface PaiementReussi {
  id: string;
  reference: string | null;
  amount: number | null;
  created_at: Date | null;
}

/**
 * PAIEMENT REÇU DEUX FOIS (revue du 02/10) : ce que la commande avait déjà
 * encaissé AVANT ce paiement.
 *
 * Seuls comptent les paiements réussis enregistrés avant lui, d'une autre
 * transaction. L'ordre d'enregistrement rend la réponse stable : rejoué,
 * le second paiement reste « en double » et le premier ne le devient jamais,
 * même une fois le second enregistré. Sans lui, chacun des deux se
 * verrait couvert par l'autre, et l'équipe rembourserait les deux. Deux
 * transactions enregistrées à la même milliseconde sont départagées par leur
 * identifiant : l'une des deux, et une seule, est signalée.
 *
 * Une même transaction enregistrée deux fois (webhook et confirmation de
 * l'application au même instant) ne compte pas : c'est le même argent.
 *
 * Montant sans la commission KKiaPay (`amount`, pas `total`) : c'est ce que
 * le client a réglé pour la commande. Plus prudent que le cumul qui marque la
 * commande payée (`total`, commission comprise) : un paiement qui complète
 * vraiment un acompte ne doit jamais être annoncé « à rembourser ».
 */
export function encaisseAvant(
  paiements: PaiementReussi[],
  courant: { id: string; reference: string | null; created_at: Date | null },
): number {
  const instant = (date: Date | null) => (date ? new Date(date).getTime() : Number.NaN);
  const enregistreLe = instant(courant.created_at);
  // NaN (date absente) n'est jamais « avant » ni « au même instant » : dans
  // le doute, rien.
  const avant = (p: PaiementReussi) => {
    const le = instant(p.created_at);
    return le < enregistreLe || (le === enregistreLe && p.id < courant.id);
  };
  return paiements
    .filter((p) => p.id !== courant.id && p.reference !== courant.reference && avant(p))
    .reduce((somme, p) => somme + (p.amount ?? 0), 0);
}

/**
 * Le paiement arrive-t-il sur une commande déjà réglée ?
 *
 * Oui quand les paiements précédents couvraient déjà son montant, à la
 * tolérance près (même règle que `etatApresEncaissement`). Un paiement qui
 * complète un encaissement partiel n'est pas en double, même s'il dépasse le
 * reste dû.
 */
export function estPaiementEnDouble(
  montantCommande: number | null | undefined,
  dejaEncaisse: number,
): boolean {
  if (montantCommande == null || dejaEncaisse <= 0) return false;
  return dejaEncaisse >= montantCommande - PAYMENT_AMOUNT_TOLERANCE;
}
