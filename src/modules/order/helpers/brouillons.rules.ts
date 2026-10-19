import { EntityStatus, OrderChannel, OrderStatus, PaymentMethod, Prisma, UserRole } from '@prisma/client';
import { commandeEffective } from 'src/modules/crm/crm.rules';
import { estAConfirmer } from './paiement-livraison.rules';

/**
 * LES BROUILLONS : paniers non payés de l'application et commandes du site à
 * confirmer.
 *
 * Doit rester identique à son jumeau de l'autre côté
 * (`backoffice/features/orders/utils/brouillons.ts`).
 *
 * Un brouillon est une commande passée par le client, encore en attente et
 * non payée : payable en ligne (application ou site), ou commande du site à
 * payer à la livraison que le centre d'appels n'a pas encore confirmée
 * (`paiement-livraison.rules.ts`). Ce n'est pas encore une commande : les
 * restaurants ne la voient pas, seuls le centre d'appels et les
 * administrateurs la suivent (relance téléphonique).
 */

/** Rôles qui voient les brouillons. Seule définition du serveur. */
export const ROLES_BROUILLONS = [UserRole.ADMIN, UserRole.CALL_CENTER] as const;

export function peutVoirLesBrouillons(user?: { role?: UserRole | string | null } | null): boolean {
  return !!user?.role && (ROLES_BROUILLONS as readonly string[]).includes(user.role);
}

/**
 * Brouillon, en Prisma : commande passée par le client (`auto`), non
 * supprimée, qui n'est PAS une commande effective au sens du CRM. Le
 * complément est pris de `commandeEffective()`, jamais recopié : si la
 * définition d'une commande qui compte évolue, celle du brouillon suit.
 * Revient à : non payée, en attente, non supprimée, et soit payable en ligne,
 * soit du site à payer à la livraison (commande à confirmer).
 */
export const BROUILLON_WHERE: Prisma.OrderWhereInput = {
  auto: true,
  entity_status: { not: EntityStatus.DELETED },
  NOT: commandeEffective(),
};

/** Ce qu'il faut lire d'une commande pour savoir si c'est un brouillon. */
export interface EtatBrouillon {
  auto?: boolean | null;
  status?: OrderStatus | string | null;
  paied?: boolean | null;
  payment_method?: PaymentMethod | string | null;
  entity_status?: EntityStatus | string | null;
  /**
   * Canal de création. Seule une commande du site (WEB) payable à la
   * livraison est un brouillon : un appelant qui ne le lit pas obtient
   * « pas brouillon » pour une commande OFFLINE, le comportement d'avant.
   */
  channel?: OrderChannel | string | null;
  /** Lu seulement par `estPanierAnnuleParClient`. */
  cancelled_by?: string | null;
}

/**
 * Même règle que `BROUILLON_WHERE`, sur une commande déjà en mémoire
 * (diffusions socket, contrôles avant un geste). Un test vérifie que les deux
 * définitions donnent le même verdict sur toutes les combinaisons.
 */
export function estBrouillon(commande?: EtatBrouillon | null): boolean {
  if (!commande) return false;
  const panierEnLigne =
    commande.auto === true &&
    commande.status === OrderStatus.PENDING &&
    commande.paied !== true &&
    commande.payment_method === PaymentMethod.ONLINE &&
    commande.entity_status !== EntityStatus.DELETED;
  return panierEnLigne || estAConfirmer(commande);
}

/**
 * Mode de paiement d'un brouillon : en ligne (application ou site), ou à la
 * livraison sur le site. Lu par la règle des paniers annulés par le client,
 * en Prisma et en mémoire.
 */
const PAYABLE_PAR_LE_CLIENT_WHERE: Prisma.OrderWhereInput[] = [
  { payment_method: PaymentMethod.ONLINE },
  { payment_method: PaymentMethod.OFFLINE, channel: OrderChannel.WEB },
];

function payableParLeClient(commande: EtatBrouillon): boolean {
  return (
    commande.payment_method === PaymentMethod.ONLINE ||
    (commande.payment_method === PaymentMethod.OFFLINE && commande.channel === OrderChannel.WEB)
  );
}

// ---------------------------------------------------------------------------
// Paniers annulés par le client (demande du 01/10)
// ---------------------------------------------------------------------------

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

/**
 * Panier annulé par le client : un brouillon (non payé, payable en ligne, ou
 * commande du site à payer à la livraison) que le client a annulé lui-même
 * avant de payer ou d'être appelé. Il est SUPPRIMÉ des listes (`entity_status`
 * DELETED : ni Commandes, ni En cours, ni statistiques, ni CRM), mais reste
 * relançable : le centre d'appels le voit dans « À relancer » avec le motif
 * « Annulée par le client », et le reprendre au téléphone le réactive
 * (`OrderService.update`).
 *
 * ⚠️ Le mode de paiement est un `OR` : qui étale cet objet dans un `where`
 * ne doit pas y avoir son propre `OR`.
 */
export const PANIER_ANNULE_PAR_CLIENT_WHERE: Prisma.OrderWhereInput = {
  auto: true,
  OR: PAYABLE_PAR_LE_CLIENT_WHERE,
  paied: false,
  status: OrderStatus.CANCELLED,
  entity_status: EntityStatus.DELETED,
  cancelled_by: ANNULEE_PAR_CLIENT,
};

/**
 * Commande SUPPRIMÉE par l'annulation du client, PAYÉE OU NON : la règle
 * ci-dessus sans la condition sur `paied`, et en ligne seulement (une
 * commande à payer à la livraison n'attend aucun paiement en ligne). Sert au
 * seul paiement en ligne arrivé après l'annulation : le retrouver par sa
 * référence (`OrderService.findByReferenceOrNull`, même au rejeu d'un webhook
 * dont un premier passage a déjà posé `paied`), puis rendre visible la
 * commande payée (`PaiementsService`, avec `paied: true`).
 */
export const ANNULEE_PAR_CLIENT_SUPPRIMEE_WHERE: Prisma.OrderWhereInput = {
  auto: true,
  payment_method: PaymentMethod.ONLINE,
  status: OrderStatus.CANCELLED,
  entity_status: EntityStatus.DELETED,
  cancelled_by: ANNULEE_PAR_CLIENT,
};

/** Même règle que `PANIER_ANNULE_PAR_CLIENT_WHERE`, sur une commande en mémoire. */
export function estPanierAnnuleParClient(commande?: EtatBrouillon | null): boolean {
  if (!commande) return false;
  return (
    commande.auto === true &&
    payableParLeClient(commande) &&
    commande.paied !== true &&
    commande.status === OrderStatus.CANCELLED &&
    commande.entity_status === EntityStatus.DELETED &&
    commande.cancelled_by === ANNULEE_PAR_CLIENT
  );
}

/**
 * Ce que suit la relance : les brouillons ET les paniers annulés par le
 * client. Seule lecture des commandes relançables (`OrderRelanceService`).
 */
export const RELANCABLE_WHERE: Prisma.OrderWhereInput = {
  OR: [BROUILLON_WHERE, PANIER_ANNULE_PAR_CLIENT_WHERE],
};

/** Même règle que `RELANCABLE_WHERE`, sur une commande en mémoire. */
export function estRelancable(commande?: EtatBrouillon | null): boolean {
  return estBrouillon(commande) || estPanierAnnuleParClient(commande);
}
