import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EntityStatus, OrderStatus, PaiementStatus, User } from '@prisma/client';
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


// ─────────────────────────────────────────────────────────────────────────────
// PAIEMENTS DE TROP (18/11)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Motifs d'un encaissement du livreur refusé (paiement passé de « en attente »
 * à FAILED). Les écrans les reconnaissent pour afficher « Refusé » plutôt
 * qu'« Échec ».
 */
export const REFUS_ENCAISSEMENT = {
  /** Refusé à la main, par la caisse ou le back office. */
  PAR_LE_RESTAURANT: 'REFUSE_PAR_LE_RESTAURANT',
  /** Refusé d'office : un paiement KKiaPay a soldé la commande. */
  PAYEE_EN_LIGNE: 'REFUSE_PAYEE_EN_LIGNE',
} as const;

export const CODES_REFUS_ENCAISSEMENT: string[] = Object.values(REFUS_ENCAISSEMENT);

/** Ce qu'il faut d'un paiement pour compter ce que la commande a reçu ou attend. */
export interface PaiementCompte {
  status: PaiementStatus;
  amount: number | null;
}

/**
 * Ce que la commande a reçu (paiements réussis) et ce que le livreur a déclaré
 * sans que ce soit encore confirmé (paiements en attente).
 *
 * Montant SANS la commission KKiaPay (`amount`, pas `total`), comme
 * `encaisseAvant` : c'est ce que le client a réglé pour la commande. Le reste
 * à encaisser est ainsi le plus large possible, et le paiement qui solde
 * vraiment la commande n'est jamais refusé.
 */
export function cumulDesPaiements(paiements: PaiementCompte[]): { recu: number; enAttente: number } {
  let recu = 0;
  let enAttente = 0;
  for (const p of paiements) {
    if (p.status === PaiementStatus.SUCCESS) recu += p.amount ?? 0;
    else if (p.status === PaiementStatus.PENDING) enAttente += p.amount ?? 0;
  }
  return { recu, enAttente };
}

/** « 4 000 XOF » : même écriture que les autres messages d'encaissement. */
const xof = (montant: number) => `${Math.round(montant).toLocaleString('fr-FR')} XOF`;

/** Comparaison au franc près : les montants sont des nombres à virgule en base. */
const depasse = (montant: number, plafond: number) => Math.round(montant) > Math.round(plafond);

/**
 * AJOUT D'UN PAIEMENT (caisse, back office) : refuse ce qui ferait dépasser le
 * prix de la commande.
 *
 * Avant le 18/11, seul un ajout sur une commande DÉJÀ soldée était refusé :
 * 15 000 XOF saisis pour une commande à 10 000 passaient, et la commande
 * restait « payée » avec 5 000 de trop.
 *
 * Les encaissements que le livreur a déclarés comptent comme s'ils étaient
 * reçus : la caissière encaissait de nouveau ce que le livreur avait déjà
 * rapporté, et la confirmation suivante doublait le paiement. Elle doit d'abord
 * confirmer ou refuser la déclaration du livreur.
 */
export function verifierAjoutSansExces(
  montantCommande: number,
  paiements: PaiementCompte[],
  ajout: number,
): void {
  const { recu, enAttente } = cumulDesPaiements(paiements);
  const reste = Math.max(0, montantCommande - recu - enAttente);
  if (!depasse(ajout, reste)) return;
  const declaration =
    `Le livreur a déjà déclaré ${xof(enAttente)}, en attente de confirmation : ` +
    `confirmez ou refusez ce paiement avant d'en ajouter un autre.`;
  if (Math.round(reste) <= 0) {
    throw new BadRequestException(enAttente > 0 ? declaration : 'Commande déjà payée.');
  }
  throw new BadRequestException(
    `Paiement de trop : il reste ${xof(reste)} à encaisser sur cette commande.` +
      (enAttente > 0 ? ` ${declaration}` : ''),
  );
}

/**
 * CONFIRMATION D'UN ENCAISSEMENT DU LIVREUR : refuse ce qui ferait dépasser le
 * prix de la commande. Elle a déjà reçu ce qu'il faut (paiement en ligne,
 * caisse, autre déclaration confirmée) : cette déclaration est à refuser.
 */
export function verifierConfirmationSansExces(
  montantCommande: number,
  paiements: PaiementCompte[],
  declare: number,
): void {
  const { recu } = cumulDesPaiements(paiements);
  const reste = Math.max(0, montantCommande - recu);
  if (!depasse(declare, reste)) return;
  if (Math.round(reste) <= 0) {
    throw new BadRequestException('Commande déjà payée : ce paiement serait de trop. Refusez-le.');
  }
  throw new BadRequestException(
    `Ce paiement dépasse ce qui reste à encaisser (${xof(reste)}) : refusez-le, puis ajoutez le bon montant.`,
  );
}

/**
 * CORRECTION PAR L'ADMINISTRATEUR (montant modifié, statut passé à réussi,
 * paiement créé directement) : même plafond. Seule une HAUSSE est contrôlée :
 * baisser un paiement de trop enregistré avant le 18/11 reste toujours permis.
 *
 * @param autres paiements de la commande, sans celui qui est corrigé
 * @param avant montant réussi avant la correction (0 s'il n'était pas réussi)
 * @param apres montant réussi après la correction (0 s'il ne l'est plus)
 */
export function verifierCorrectionSansExces(
  montantCommande: number,
  autres: PaiementCompte[],
  avant: number,
  apres: number,
): void {
  if (!depasse(apres, avant)) return;
  const { recu } = cumulDesPaiements(autres);
  if (!depasse(recu + apres, montantCommande)) return;
  throw new BadRequestException(
    `Ce montant dépasserait le prix de la commande : ${xof(recu)} déjà reçus ailleurs pour ${xof(montantCommande)}.`,
  );
}
