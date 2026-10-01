import { EntityStatus, OrderStatus, PaymentMethod, Prisma, UserRole } from '@prisma/client';
import { commandeEffective } from 'src/modules/crm/crm.rules';

/**
 * LES BROUILLONS DE L'APPLICATION (paniers non payés).
 *
 * Doit rester identique à son jumeau de l'autre côté
 * (`backoffice/features/orders/utils/brouillons.ts`).
 *
 * Un brouillon est une commande passée depuis l'application, payable en ligne,
 * encore en attente et non payée. Ce n'est pas encore une commande : les
 * restaurants ne la voient pas, seuls le centre d'appels et les
 * administrateurs la suivent (relance téléphonique).
 */

/** Rôles qui voient les paniers non payés de l'application. Seule définition du serveur. */
export const ROLES_BROUILLONS = [UserRole.ADMIN, UserRole.CALL_CENTER] as const;

export function peutVoirLesBrouillons(user?: { role?: UserRole | string | null } | null): boolean {
  return !!user?.role && (ROLES_BROUILLONS as readonly string[]).includes(user.role);
}

/**
 * Brouillon, en Prisma : commande de l'application, non supprimée, qui n'est
 * PAS une commande effective au sens du CRM. Le complément est pris de
 * `commandeEffective()`, jamais recopié : si la définition d'une commande qui
 * compte évolue, celle du brouillon suit. Revient à : paiement en ligne, non
 * payée, en attente, non supprimée.
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
  return (
    commande.auto === true &&
    commande.status === OrderStatus.PENDING &&
    commande.paied !== true &&
    commande.payment_method === PaymentMethod.ONLINE &&
    commande.entity_status !== EntityStatus.DELETED
  );
}

// ---------------------------------------------------------------------------
// Paniers annulés par le client (demande du 01/10)
// ---------------------------------------------------------------------------

/**
 * Valeur de `Order.cancelled_by` posée quand le CLIENT annule lui-même, depuis
 * l'application (`PATCH /orders/:id/client/status`), un panier non payé.
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
 * Panier annulé par le client : un brouillon (application, en ligne, non
 * payé) que le client a annulé lui-même avant de payer. Il est SUPPRIMÉ des
 * listes (`entity_status` DELETED : ni Commandes, ni En cours, ni
 * statistiques, ni CRM), mais reste relançable : le centre d'appels le voit
 * dans « À relancer » avec le motif « Annulée par le client », et le reprendre
 * au téléphone le réactive (`OrderService.update`).
 */
export const PANIER_ANNULE_PAR_CLIENT_WHERE: Prisma.OrderWhereInput = {
  auto: true,
  payment_method: PaymentMethod.ONLINE,
  paied: false,
  status: OrderStatus.CANCELLED,
  entity_status: EntityStatus.DELETED,
  cancelled_by: ANNULEE_PAR_CLIENT,
};

/**
 * Commande SUPPRIMÉE par l'annulation du client, PAYÉE OU NON : la règle
 * ci-dessus sans la condition sur `paied`. Sert au seul paiement en ligne
 * arrivé après l'annulation : le retrouver par sa référence
 * (`OrderService.findByReferenceOrNull`, même au rejeu d'un webhook dont un
 * premier passage a déjà posé `paied`), puis rendre visible la commande payée
 * (`PaiementsService`, avec `paied: true`).
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
    commande.payment_method === PaymentMethod.ONLINE &&
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
