import { EntityStatus, LoyaltyPointType, OrderStatus, Prisma } from '@prisma/client';

/**
 * POINTS DE FIDÉLITÉ UTILISÉS SUR UNE COMMANDE : règles pures (02/10).
 *
 * Seule définition du calcul côté serveur, partagée par la création client
 * (create-v2, appli et site) et par celle du personnel (create). Elle répond à
 * deux questions :
 *  - quelle remise accorder pour les points demandés ;
 *  - combien de points cette remise COÛTE réellement au client.
 *
 * Avant, la commande enregistrait les points DEMANDÉS alors que la remise était
 * plafonnée : 150 points demandés sur un panier de 4 000 F donnaient 2 000 F de
 * remise (plafond 50 %), soit 100 points, mais 150 étaient retirés.
 */

/** Réglages de la fidélité lus par le calcul (ligne `LoyaltyConfig`). */
export interface ReglagesPoints {
  minimum_redemption_points: number;
  point_value_in_xof: number;
  max_redemption_pct?: number | null;
}

export interface RemiseFidelite {
  /** Remise en francs, entière. */
  remise: number;
  /** Points que la commande enregistre, donc ceux qui seront retirés. */
  points: number;
}

export const AUCUNE_REMISE_FIDELITE: RemiseFidelite = Object.freeze({ remise: 0, points: 0 });

/**
 * Plafond de la remise en points, en francs, pour une assiette donnée (plats,
 * options et suppléments, hors livraison et taxe).
 *
 * `max_redemption_pct` à 0, absent ou au moins 100 voulait dire « aucun
 * plafond » : la remise pouvait alors dépasser le panier et rendre le total
 * négatif. Elle reste désormais bornée à l'assiette elle-même.
 */
export function plafondRemiseFidelite(assiette: number, pct?: number | null): number {
  const base = Math.max(0, Math.floor(Number(assiette) || 0));
  const taux = Number(pct) || 0;
  if (taux <= 0 || taux >= 100) return base;
  return Math.min(base, Math.floor((taux / 100) * base));
}

/**
 * Remise accordée pour `pointsDemandes`, et points réellement consommés.
 *
 * Comportement silencieux conservé (l'application ne sait pas afficher autre
 * chose) : sous le minimum, ou au-delà du solde DISPONIBLE, la remise vaut 0.
 * Le solde disponible est le solde moins les points déjà promis à d'autres
 * commandes payées mais pas encore déduites (voir `pointsEngagesWhere`).
 *
 * `autresRemises` : remises déjà prises sur la même assiette (promotion du
 * chemin du personnel). Le total des remises ne dépassant jamais l'assiette,
 * la part couverte par les points s'arrête là où commence la promotion :
 * on ne retire pas de points pour une remise que le client n'a pas eue.
 *
 * Points enregistrés : ceux qui couvrent la remise accordée, arrondis au point
 * supérieur, jamais plus que demandé. Jamais moins que le minimum non plus :
 * `redeemPoints` refuse de retirer moins, et la remise serait alors offerte
 * sans aucun retrait. Le client demande au moins le minimum, ce plancher ne
 * lui prend donc jamais plus que ce qu'il a lui-même proposé.
 */
export function calculerRemiseFidelite(params: {
  pointsDemandes: number;
  soldeDisponible: number;
  assiette: number;
  autresRemises?: number;
  reglages: ReglagesPoints;
}): RemiseFidelite {
  const { reglages } = params;
  const demandes = Math.floor(Number(params.pointsDemandes) || 0);
  if (demandes <= 0) return AUCUNE_REMISE_FIDELITE;
  if (demandes < reglages.minimum_redemption_points) return AUCUNE_REMISE_FIDELITE;
  if ((Number(params.soldeDisponible) || 0) < demandes) return AUCUNE_REMISE_FIDELITE;

  const valeur = Number(reglages.point_value_in_xof) || 0;
  if (valeur <= 0) return AUCUNE_REMISE_FIDELITE;

  const brut = Math.floor(demandes * valeur);
  const plafond = Math.min(
    plafondRemiseFidelite(params.assiette, reglages.max_redemption_pct),
    Math.max(0, Math.floor((Number(params.assiette) || 0) - (Number(params.autresRemises) || 0))),
  );
  const remise = Math.max(0, Math.min(brut, plafond));
  if (remise <= 0) return AUCUNE_REMISE_FIDELITE;
  if (remise >= brut) return { remise, points: demandes };

  // Petite marge contre l'arrondi des flottants (2000 / 0.1 = 20000.000000000004).
  const couverts = Math.ceil(remise / valeur - 1e-9);
  const points = Math.min(demandes, Math.max(couverts, reglages.minimum_redemption_points));
  return { remise, points };
}

/**
 * Commandes d'un client dont les points sont ENGAGÉS : la remise a été
 * accordée et la commande est payée (ou confirmée par le personnel), mais
 * aucun retrait n'est encore enregistré.
 *
 * Depuis le 02/10, le retrait se fait au paiement : la liste est vide en temps
 * normal. Elle compte les retraits qui ont échoué, pour que les mêmes points
 * ne paient pas deux paniers. Un panier non payé n'engage rien : ses points ne
 * sont pas encore promis.
 *
 * Seules les commandes passées depuis la mise en place de cette règle
 * comptent. Les anciennes commandes jamais déduites (fuite d'avant le 23/07)
 * auraient sinon baissé en silence le solde utilisable de leurs clients, alors
 * que l'application affiche toujours le solde complet : elles relèvent de la
 * réconciliation (POST /fidelity/loyalty/points/reconcile), pas de ce garde-fou.
 */
export const DEBUT_POINTS_ENGAGES = new Date('2026-10-02T00:00:00.000Z');

export function pointsEngagesWhere(customer_id: string): Prisma.OrderWhereInput {
  return {
    customer_id,
    created_at: { gte: DEBUT_POINTS_ENGAGES },
    points: { gt: 0 },
    entity_status: { not: EntityStatus.DELETED },
    status: { not: OrderStatus.CANCELLED },
    OR: [{ paied: true }, { status: { not: OrderStatus.PENDING } }],
    loyalty_points: { none: { type: LoyaltyPointType.REDEEMED } },
  };
}

/**
 * Lignes qui créditent des points DÉPENSABLES : un retrait les consomme, et
 * elles expirent. Les points rendus (REFUNDED) en font partie, même s'ils ne
 * comptent ni pour le niveau ni pour `lifetime_points` : ce ne sont pas des
 * gains, seulement des points que le client avait déjà et qu'on lui rend.
 */
export const TYPES_POINTS_DEPENSABLES: LoyaltyPointType[] = [
  LoyaltyPointType.EARNED,
  LoyaltyPointType.BONUS,
  LoyaltyPointType.REFUNDED,
];

/**
 * Points encore retirés au client pour UNE commande : ses retraits (REDEEMED)
 * moins les points déjà rendus (REFUNDED). Depuis le 03/10, la ligne de
 * retrait ne change plus quand la commande est annulée ; c'est ce solde qui
 * dit si la commande a encore des points à rendre, ou si elle est déjà
 * déduite. 0 : rien de retiré, ou tout a été rendu.
 */
export function pointsRetiresNets(lignes: { type: LoyaltyPointType; points: number }[]): number {
  let net = 0;
  for (const ligne of lignes) {
    if (ligne.type === LoyaltyPointType.REDEEMED) net += ligne.points;
    else if (ligne.type === LoyaltyPointType.REFUNDED) net -= ligne.points;
  }
  return Math.max(0, net);
}

/** Libellé du retrait, dans l'historique du client (inchangé depuis l'origine). */
export function libelleRetrait(points: number, reference: string): string {
  return `🔥 ${points} points utilisés pour la commande #${reference}`;
}

/**
 * Libellé de la ligne REFUNDED qui rend les points d'une commande annulée.
 * L'application l'affiche tel quel, en vert avec un « + » : elle ne connaît
 * pas ce type et le traite comme un crédit. La phrase porte le nombre de
 * points et la commande : elle se comprend seule, sans le badge à côté.
 *
 * Même texte que le crédit BONUS écrit du 02/10 au 03/10 : la migration
 * 20261003090100_points_rendus_reprise le retrouve à l'identique.
 */
export function libelleRestitution(points: number, reference: string): string {
  return `${points} points rendus : commande #${reference} annulée`;
}

/** Libellé de la part expirée de points rendus jamais dépensés. */
export function libelleRendusExpires(points: number, reference: string | null): string {
  return reference
    ? `${points} points rendus expirés : commande #${reference}`
    : `${points} points rendus expirés`;
}
