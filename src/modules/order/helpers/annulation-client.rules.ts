import { EntityStatus, OrderChannel, OrderStatus, PaymentMethod, Prisma } from '@prisma/client';
// Sans cycle : ce fichier-là n'importe que Prisma, lui aussi.
import { NI_SITE_NI_REPERE, SITE_OU_REPERE, siteOuRepere } from './paiement-livraison.rules';

/**
 * PANIERS ANNULÉS PAR LE CLIENT (demande du 01/10, revue le 25/11).
 *
 * Fichier à part, sans autre dépendance que Prisma : la règle « commande qui
 * compte » du CRM (`crm.rules.ts`) l'écarte, et les règles des brouillons
 * (`brouillons.rules.ts`) importent déjà le CRM. Les deux importent d'ici.
 */

/**
 * Valeur de `Order.cancelled_by` posée quand le CLIENT annule lui-même, depuis
 * l'application ou le site (`PATCH /orders/:id/client/status`), un brouillon :
 * panier non payé, ou commande du site à confirmer (« Modifier ma commande »).
 *
 * Constante, et non plus l'identifiant du client : c'est le marqueur que
 * lisent la relance, la lecture d'une commande et la réactivation, et il doit
 * pouvoir s'écrire dans un `where` Prisma (comparer deux colonnes ne s'y écrit
 * pas). Rien n'est perdu : l'auteur est le titulaire de la commande,
 * `customer_id`. Les annulations par le personnel gardent l'identifiant de
 * l'agent. La migration 20261001180000 a posé cette valeur sur les paniers
 * annulés par le client entre le 30/09 et ce correctif.
 */
export const ANNULEE_PAR_CLIENT = 'client';

/** Ce que la règle lit d'une commande en mémoire. */
export interface EtatAnnulationClient {
  auto?: boolean | null;
  status?: OrderStatus | string | null;
  paied?: boolean | null;
  payment_method?: PaymentMethod | string | null;
  channel?: OrderChannel | string | null;
  /** Repère « à confirmer » posé à la création (26/11), appli ou site. */
  a_confirmer?: boolean | null;
  cancelled_by?: string | null;
}

/**
 * Mode de paiement d'un brouillon : en ligne (application ou site), ou à la
 * réception pour une commande à confirmer (du site, ou portant le repère
 * `a_confirmer` depuis le 26/11 : application comprise).
 */
export const PAYABLE_PAR_LE_CLIENT_WHERE: Prisma.OrderWhereInput[] = [
  { payment_method: PaymentMethod.ONLINE },
  { payment_method: PaymentMethod.OFFLINE, OR: SITE_OU_REPERE },
];

export function payableParLeClient(commande: EtatAnnulationClient): boolean {
  return (
    commande.payment_method === PaymentMethod.ONLINE ||
    (commande.payment_method === PaymentMethod.OFFLINE && siteOuRepere(commande))
  );
}

/**
 * Panier annulé par le client : un brouillon (non payé, payable en ligne, ou
 * commande du site à payer à la livraison) que le client a annulé lui-même
 * avant de payer ou d'être appelé.
 *
 * Depuis le 25/11 (demande du client), il reste ACTIF (`entity_status`
 * ACTIVE) : il se voit dans Commandes, au statut Annulée. Avant, il était
 * supprimé ; la règle ne lit donc plus `entity_status`, et reconnaît aussi
 * ces anciens paniers supprimés. Il ne compte toujours pas comme une
 * commande : ni pour le CRM (`commandeEffective`), ni dans les statistiques,
 * ni pour dire qu'un client « a commandé ». Il reste relançable : le centre
 * d'appels le voit dans « À relancer » avec le motif « Annulée par le
 * client », et le reprendre au téléphone le réactive (`OrderService.update`).
 *
 * ⚠️ Le mode de paiement est un `OR` : qui étale cet objet dans un `where`
 * ne doit pas y avoir son propre `OR` (ou l'écrire dans un `NOT` / un `AND`).
 */
export const PANIER_ANNULE_PAR_CLIENT_WHERE: Prisma.OrderWhereInput = {
  auto: true,
  OR: PAYABLE_PAR_LE_CLIENT_WHERE,
  paied: false,
  status: OrderStatus.CANCELLED,
  cancelled_by: ANNULEE_PAR_CLIENT,
};

/**
 * Complément EXACT de `PANIER_ANNULE_PAR_CLIENT_WHERE`, en positif : à écrire
 * à la place d'un `NOT`. En SQL, `NOT (... "cancelled_by" = 'client')` vaut
 * NULL quand le motif, le canal ou le mode de paiement est vide, et la
 * commande disparaissait (une annulation ordinaire sans auteur, une commande
 * d'avant le 02/10 sans canal).
 */
export const PAS_PANIER_ANNULE_PAR_CLIENT_WHERE: Prisma.OrderWhereInput = {
  OR: [
    { auto: false },
    { payment_method: null },
    {
      AND: [
        { payment_method: { not: PaymentMethod.ONLINE } },
        { OR: [{ payment_method: { not: PaymentMethod.OFFLINE } }, NI_SITE_NI_REPERE] },
      ],
    },
    { paied: true },
    { status: { not: OrderStatus.CANCELLED } },
    { cancelled_by: null },
    { cancelled_by: { not: ANNULEE_PAR_CLIENT } },
  ],
};

/**
 * Même règle en SQL, sur la table "Order" aliasée `a`. `IS NOT DISTINCT FROM`
 * et `IS TRUE` : jamais NULL, un `NOT` devant reste sûr.
 */
export const PANIER_ANNULE_PAR_CLIENT_SQL = (a: string) => `(${a}."auto" IS TRUE
    AND (${a}."payment_method" IS NOT DISTINCT FROM 'ONLINE'
      OR (${a}."payment_method" IS NOT DISTINCT FROM 'OFFLINE'
        AND (${a}."channel" IS NOT DISTINCT FROM 'WEB' OR ${a}."a_confirmer" IS TRUE)))
    AND ${a}."paied" = false AND ${a}."status" = 'CANCELLED'
    AND ${a}."cancelled_by" IS NOT DISTINCT FROM '${ANNULEE_PAR_CLIENT}')`;

/**
 * Commande annulée par le client, PAYÉE OU NON, en ligne seulement (une
 * commande à payer à la livraison n'attend aucun paiement en ligne). Sert au
 * seul paiement en ligne arrivé après l'annulation : depuis le 25/11, elle
 * reste active, et le passage qui vient de la payer signale le remboursement
 * (`PaiementsService`).
 */
export const ANNULEE_PAR_CLIENT_EN_LIGNE_WHERE: Prisma.OrderWhereInput = {
  auto: true,
  payment_method: PaymentMethod.ONLINE,
  status: OrderStatus.CANCELLED,
  cancelled_by: ANNULEE_PAR_CLIENT,
};

/**
 * La même, SUPPRIMÉE : annulée avant le 25/11 (l'annulation la supprimait),
 * ou supprimée depuis par le personnel. La retrouver par sa référence
 * (`OrderService.findByReferenceOrNull`, même au rejeu d'un webhook dont un
 * premier passage a déjà posé `paied`), puis la rendre visible
 * (`PaiementsService`, avec `paied: true`) : écriture idempotente.
 */
export const ANNULEE_PAR_CLIENT_SUPPRIMEE_WHERE: Prisma.OrderWhereInput = {
  ...ANNULEE_PAR_CLIENT_EN_LIGNE_WHERE,
  entity_status: EntityStatus.DELETED,
};

/** Même règle que `PANIER_ANNULE_PAR_CLIENT_WHERE`, sur une commande en mémoire. */
export function estPanierAnnuleParClient(commande?: EtatAnnulationClient | null): boolean {
  if (!commande) return false;
  return (
    commande.auto === true &&
    payableParLeClient(commande) &&
    commande.paied !== true &&
    commande.status === OrderStatus.CANCELLED &&
    commande.cancelled_by === ANNULEE_PAR_CLIENT
  );
}

/**
 * Paniers « abandonnés » d'un client, comptés sur sa fiche du CRM : commandes
 * supprimées (paiement en ligne abandonné) et paniers qu'il a annulés.
 */
export const PANIER_ABANDONNE_WHERE: Prisma.OrderWhereInput = {
  OR: [{ entity_status: EntityStatus.DELETED }, { AND: [PANIER_ANNULE_PAR_CLIENT_WHERE] }],
};
export const PANIER_ABANDONNE_SQL = (a: string) => `(${a}."entity_status" = 'DELETED' OR ${PANIER_ANNULE_PAR_CLIENT_SQL(a)})`;
