import { EntityStatus, OrderChannel, OrderStatus, PaymentMethod, Prisma } from '@prisma/client';

/**
 * PAIEMENT À LA LIVRAISON SUR LE SITE (19/10/2026).
 *
 * Le client choisit sur le site de payer au livreur (espèces ou Mobile
 * Money). La commande est créée par `createv2` en canal WEB, `auto`, OFFLINE,
 * non payée et en attente : c'est une COMMANDE À CONFIRMER. Le restaurant ne
 * la voit pas, le centre d'appels la trouve tout de suite dans « À relancer »,
 * appelle le client, puis la transmet par la reprise au téléphone (« Manuel »,
 * acceptée) ou l'annule.
 *
 * Seule définition de cet état côté serveur. Ce fichier n'importe que
 * `@prisma/client` : le CRM (`crm.rules.ts`), les brouillons
 * (`brouillons.rules.ts`) et la fidélité (`points-commande.rules.ts`) le lisent
 * sans créer de cycle.
 *
 * ⚠️ `channel` et `payment_method` acceptent NULL (commandes antérieures au
 * 02/10, commandes HubRise). En SQL, `channel <> 'WEB'` vaut NULL sur une
 * ligne sans canal, et la ligne sort de tout filtre : une ancienne commande
 * en espèces de l'application deviendrait un brouillon caché au restaurant.
 * D'où un complément écrit en POSITIF, avec les branches NULL explicites, et
 * un SQL en `IS NOT DISTINCT FROM`. Le moteur en mémoire des tests raisonne
 * en logique à deux valeurs et ne voit pas ce piège : la vérification se fait
 * aussi sur une vraie base (recette R12).
 */

/** Réglage de Paramètres > Commandes : « 1 » proposé, « 0 » coupé. */
export const REGLAGE_PAIEMENT_LIVRAISON_SITE = 'order_paiement_livraison_site';

/**
 * L'option est-elle proposée sur le site ?
 *
 * Absent (ou vide, comme le lit `SettingsService.getOrEnv`) : PROPOSÉE.
 * Décision du 19/10, écart à la conception qui la voulait coupée par défaut :
 * le client veut que l'option marche dès le déploiement, et garde
 * l'interrupteur dans Paramètres > Commandes.
 *
 * « 1 », « true » ou « oui » : proposée. « 0 », et toute autre valeur
 * illisible : coupée. Une saisie qu'on ne comprend pas ne doit pas ouvrir des
 * commandes que personne n'attend peut-être.
 */
export function paiementLivraisonActif(valeur?: string | null): boolean {
  if (valeur === null || valeur === undefined) return true;
  const lue = valeur.trim().toLowerCase();
  if (lue === '') return true;
  return lue === '1' || lue === 'true' || lue === 'oui';
}

/**
 * Refus de `createv2` sur le site, dans l'ordre où ils sont contrôlés. Le site
 * les affiche tels quels (champ `message` de l'erreur).
 */
export const REFUS_PAIEMENT_SITE = {
  /** 400 : ni ONLINE ni OFFLINE. */
  moyenAbsent: 'Choisissez un moyen de paiement.',
  /** 400 : réglage coupé. */
  indisponible: 'Le paiement à la livraison est indisponible pour le moment\u00a0: payez en ligne.',
  /** 400 : retrait ou sur place. */
  livraisonSeulement: "Sur le site, le paiement à la livraison n'est proposé que pour une livraison.",
  /** 409 : une commande à confirmer du même client attend déjà. */
  dejaEnAttente: (reference: string) =>
    `Vous avez déjà une commande en attente de confirmation (${reference})\u00a0: notre équipe vous appelle. ` +
    'Pour la changer, ouvrez-la puis «\u00a0Modifier ma commande\u00a0».',
} as const;

/** Ce qu'il faut lire d'une commande pour savoir si elle est à confirmer. */
export interface EtatAConfirmer {
  auto?: boolean | null;
  status?: OrderStatus | string | null;
  paied?: boolean | null;
  payment_method?: PaymentMethod | string | null;
  entity_status?: EntityStatus | string | null;
  channel?: OrderChannel | string | null;
}

/**
 * Commande du site à payer à la livraison, que le centre d'appels n'a pas
 * encore confirmée. Même règle que `A_CONFIRMER_WHERE`, sur une commande en
 * mémoire ; un test vérifie que les deux donnent le même verdict sur toutes
 * les combinaisons.
 *
 * Un appelant qui ne lit pas `channel` obtient « pas à confirmer » : le
 * comportement d'avant cette règle.
 */
export function estAConfirmer(commande?: EtatAConfirmer | null): boolean {
  if (!commande) return false;
  return (
    commande.auto === true &&
    commande.channel === OrderChannel.WEB &&
    commande.payment_method === PaymentMethod.OFFLINE &&
    commande.paied !== true &&
    commande.status === OrderStatus.PENDING &&
    commande.entity_status !== EntityStatus.DELETED
  );
}

/** Commande à confirmer, en Prisma. */
export const A_CONFIRMER_WHERE: Prisma.OrderWhereInput = {
  auto: true,
  channel: OrderChannel.WEB,
  payment_method: PaymentMethod.OFFLINE,
  paied: false,
  status: OrderStatus.PENDING,
  entity_status: { not: EntityStatus.DELETED },
};

/**
 * Complément EXACT de `A_CONFIRMER_WHERE`, hors `entity_status` (que chaque
 * appelant règle déjà), écrit en POSITIF : sûr avec NULL. Un `NOT` de la
 * règle ci-dessus ferait sortir les commandes sans canal ou sans mode de
 * paiement, la comparaison à NULL ne valant ni vrai ni faux.
 */
export const PAS_A_CONFIRMER_WHERE: Prisma.OrderWhereInput = {
  OR: [
    { auto: false },
    { channel: null },
    { channel: { not: OrderChannel.WEB } },
    { payment_method: null },
    { payment_method: { not: PaymentMethod.OFFLINE } },
    { paied: true },
    { status: { not: OrderStatus.PENDING } },
  ],
};

/**
 * Même règle en SQL, hors `entity_status`, pour la table "Order" sous l'alias
 * donné. `IS NOT DISTINCT FROM` : un canal ou un mode de paiement vide ne vaut
 * ni WEB ni OFFLINE, et le résultat n'est jamais NULL (`auto`, `paied` et
 * `status` sont obligatoires) : un `NOT` devant reste sûr. L'alias est
 * contrôlé : il est collé dans le texte de la requête.
 */
export function A_CONFIRMER_SQL(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error(`Alias SQL invalide : ${alias}`);
  return `(${alias}."auto" IS TRUE AND ${alias}."channel" IS NOT DISTINCT FROM 'WEB'
    AND ${alias}."payment_method" IS NOT DISTINCT FROM 'OFFLINE'
    AND ${alias}."paied" = false AND ${alias}."status" = 'PENDING')`;
}

// ---------------------------------------------------------------------------
// Annulée avant toute confirmation (CRM)
// ---------------------------------------------------------------------------

/**
 * Commande du site à payer à la livraison ANNULÉE PAR LE CENTRE D'APPELS
 * AVANT D'AVOIR ÉTÉ CONFIRMÉE (« Annuler la commande » de « À relancer » :
 * client injoignable, doublon, fausse commande). Elle reste active et annulée
 * (règle des annulations par le personnel), mais le client n'a jamais
 * commandé : elle ne compte pas au CRM (D5), ni pour sortir un inactif, ni
 * comme conversion, ni comme dernière commande. Une commande annulée APRÈS sa
 * confirmation (manuelle, `accepted_at` posé) compte, comme toute commande
 * annulée (règle du lot 1). Annulée par le client, elle est supprimée : déjà
 * écartée.
 *
 * Mêmes précautions que la règle « à confirmer » : complément écrit en
 * POSITIF, SQL en `IS NOT DISTINCT FROM`.
 */
export const ANNULEE_AVANT_CONFIRMATION_WHERE: Prisma.OrderWhereInput = {
  auto: true,
  channel: OrderChannel.WEB,
  payment_method: PaymentMethod.OFFLINE,
  paied: false,
  status: OrderStatus.CANCELLED,
  accepted_at: null,
};

/** Complément EXACT de `ANNULEE_AVANT_CONFIRMATION_WHERE`, en positif : sûr avec NULL. */
export const PAS_ANNULEE_AVANT_CONFIRMATION_WHERE: Prisma.OrderWhereInput = {
  OR: [
    { auto: false },
    { channel: null },
    { channel: { not: OrderChannel.WEB } },
    { payment_method: null },
    { payment_method: { not: PaymentMethod.OFFLINE } },
    { paied: true },
    { status: { not: OrderStatus.CANCELLED } },
    { accepted_at: { not: null } },
  ],
};

/** Même règle sur une commande en mémoire. */
export function estAnnuleeAvantConfirmation(
  commande?: (EtatAConfirmer & { accepted_at?: Date | string | null }) | null,
): boolean {
  if (!commande) return false;
  return (
    commande.auto === true &&
    commande.channel === OrderChannel.WEB &&
    commande.payment_method === PaymentMethod.OFFLINE &&
    commande.paied !== true &&
    commande.status === OrderStatus.CANCELLED &&
    (commande.accepted_at === null || commande.accepted_at === undefined)
  );
}

/** Même règle en SQL, jamais NULL : un `NOT` devant reste sûr. Alias contrôlé. */
export function ANNULEE_AVANT_CONFIRMATION_SQL(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error(`Alias SQL invalide : ${alias}`);
  return `(${alias}."auto" IS TRUE AND ${alias}."channel" IS NOT DISTINCT FROM 'WEB'
    AND ${alias}."payment_method" IS NOT DISTINCT FROM 'OFFLINE'
    AND ${alias}."paied" = false AND ${alias}."status" = 'CANCELLED' AND ${alias}."accepted_at" IS NULL)`;
}
