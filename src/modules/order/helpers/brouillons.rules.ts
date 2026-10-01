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
