import { EntityStatus, OrderChannel, OrderStatus, PaymentMethod, Prisma, UserRole } from '@prisma/client';
import { commandeEffective } from 'src/modules/crm/crm.rules';
import { PANIER_ANNULE_PAR_CLIENT_WHERE, estPanierAnnuleParClient } from './annulation-client.rules';
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
 * supprimée, EN ATTENTE, qui n'est PAS une commande effective au sens du CRM.
 * Le complément est pris de `commandeEffective()`, jamais recopié : si la
 * définition d'une commande qui compte évolue, celle du brouillon suit.
 * Revient à : non payée, en attente, non supprimée, et soit payable en ligne,
 * soit du site à payer à la livraison (commande à confirmer).
 *
 * « En attente » : une commande du site annulée par le centre d'appels avant
 * d'être confirmée ne compte pas au CRM (`ANNULEE_AVANT_CONFIRMATION_WHERE`),
 * mais n'est pas un brouillon pour autant (annulée, rien à relancer).
 */
export const BROUILLON_WHERE: Prisma.OrderWhereInput = {
  auto: true,
  status: OrderStatus.PENDING,
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

// ---------------------------------------------------------------------------
// Paniers annulés par le client : règle dans annulation-client.rules.ts (le
// CRM la lit aussi), reprise ici pour les appelants existants.
// ---------------------------------------------------------------------------
export {
  ANNULEE_PAR_CLIENT,
  ANNULEE_PAR_CLIENT_EN_LIGNE_WHERE,
  ANNULEE_PAR_CLIENT_SUPPRIMEE_WHERE,
  PANIER_ANNULE_PAR_CLIENT_WHERE,
  estPanierAnnuleParClient,
} from './annulation-client.rules';

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
