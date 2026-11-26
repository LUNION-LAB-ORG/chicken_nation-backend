import { OrderChannel, OrderType, PaymentMethod } from '@prisma/client';

import { paiementLivraisonActif, REGLAGE_PAIEMENT_LIVRAISON_SITE } from './paiement-livraison.rules';

/**
 * TYPES DE COMMANDE ET PAIEMENT, RÉGLÉS AU BACK-OFFICE POUR L'APPLICATION ET
 * LE SITE (demandes du 26/11).
 *
 * D'abord pour l'application seule : « contrôler depuis le back-office les
 * types de commandes, livraison, à emporter et sur place », et pour chaque
 * type le paiement : à la réception, en ligne seulement, ou les deux. Puis,
 * le même jour : « même réglage » pour le site, « paiement à la livraison sur
 * le site et appli aussi », « directe ou après confirmation ».
 *
 * Paramètres > Commandes :
 *  - `order_type_<type>` : où le type est proposé. Le client coche « Appli »
 *    et/ou « Site web » (« on doit cocher site web ou appli », 26/11) : la
 *    valeur est la liste des canaux cochés, `APP,WEB`, `APP`, `WEB`. « 1 »
 *    vaut les deux, « 0 » aucun ;
 *  - `order_paiement_<type>` : `EN_LIGNE`, `A_LA_RECEPTION` ou `LES_DEUX` ;
 *  - `order_paiement_reception` : ce que devient une commande à payer à la
 *    réception. `DIRECTE` : elle part au restaurant, acceptée.
 *    `APRES_CONFIRMATION` : le centre d'appels l'appelle d'abord
 *    (`paiement-livraison.rules.ts`, commande « à confirmer »).
 *
 * Clés absentes : ce qui se faisait avant ces réglages.
 *  - Livraison et à emporter proposés, sur place non.
 *  - Paiement en ligne seulement, SAUF la livraison : elle reprend l'ancien
 *    réglage du site (`order_paiement_livraison_site`, proposé s'il est
 *    absent). Le site ne perd donc pas son paiement à la livraison au
 *    déploiement ; c'est désormais le même réglage que l'application.
 *  - Après confirmation : ce que le site faisait déjà.
 *
 * L'application et le site lisent ces réglages par
 * `GET /orders/conditions-commande` (`types`, `reception`) et n'affichent que
 * ce qui est permis ; `createv2` les contrôle à la création, seule vraie
 * garantie : une version plus ancienne ne les lit pas et reçoit alors le
 * refus en clair. Le centre d'appels et la caisse ne sont pas concernés.
 *
 * Fonctions pures : testées sans base.
 */

/** Moyens de paiement permis pour un type de commande. */
export type PaiementCommande = 'EN_LIGNE' | 'A_LA_RECEPTION' | 'LES_DEUX';

export const PAIEMENTS_COMMANDE: readonly PaiementCommande[] = ['EN_LIGNE', 'A_LA_RECEPTION', 'LES_DEUX'];

/** Ce que devient une commande à payer à la réception. */
export type ModeReception = 'DIRECTE' | 'APRES_CONFIRMATION';

/** Canal d'une commande passée par le client : l'application ou le site. */
export type CanalClient = 'APP' | 'WEB';

export const CANAUX_CLIENT: readonly CanalClient[] = ['APP', 'WEB'];

/** Réglage « Commande à payer à la réception ». */
export const REGLAGE_RECEPTION = 'order_paiement_reception';

/** Clé absente ou illisible : le centre d'appels confirme d'abord (ce que le site faisait). */
export const RECEPTION_PAR_DEFAUT: ModeReception = 'APRES_CONFIRMATION';

/** Clés des réglages, par type de commande. */
export const REGLAGES_TYPES: Record<OrderType, { actif: string; paiement: string }> = {
  [OrderType.DELIVERY]: { actif: 'order_type_livraison', paiement: 'order_paiement_livraison' },
  [OrderType.PICKUP]: { actif: 'order_type_emporter', paiement: 'order_paiement_emporter' },
  [OrderType.TABLE]: { actif: 'order_type_sur_place', paiement: 'order_paiement_sur_place' },
};

/** Toutes les clés à lire d'un coup, ancien réglage du site compris. */
export const CLES_REGLAGES_COMMANDE: string[] = [
  ...Object.values(REGLAGES_TYPES).flatMap((c) => [c.actif, c.paiement]),
  REGLAGE_RECEPTION,
  REGLAGE_PAIEMENT_LIVRAISON_SITE,
];

/**
 * Clé absente : avant ces réglages, la livraison et le retrait étaient
 * proposés sur l'application et le site, « sur place » nulle part.
 */
const CANAUX_PAR_DEFAUT: Record<OrderType, readonly CanalClient[]> = {
  [OrderType.DELIVERY]: CANAUX_CLIENT,
  [OrderType.PICKUP]: CANAUX_CLIENT,
  [OrderType.TABLE]: [],
};

/** Mots acceptés pour un canal dans la valeur du réglage. */
const MOTS_DU_CANAL: Record<string, CanalClient> = {
  APP: 'APP',
  APPLI: 'APP',
  APPLICATION: 'APP',
  WEB: 'WEB',
  SITE: 'WEB',
};

/** Clé absente : en ligne seulement (hors livraison, voir `paiementDuType`). */
export const PAIEMENT_PAR_DEFAUT: PaiementCommande = 'EN_LIGNE';

/** Nom du type dans les messages au client. */
const NOM_DU_TYPE: Record<OrderType, string> = {
  [OrderType.DELIVERY]: 'La livraison',
  [OrderType.PICKUP]: 'La commande à emporter',
  [OrderType.TABLE]: 'La commande sur place',
};

export interface TypeCommande {
  /** Le type est proposé. */
  actif: boolean;
  paiement: PaiementCommande;
  /** Pourquoi le type n'est pas proposé (affiché tel quel) ; `null` s'il l'est. */
  message: string | null;
}

export type ReglagesCommande = Record<OrderType, TypeCommande>;

/**
 * « 1 », « true », « oui » : proposé. Vide ou absent : la valeur par défaut du
 * type. Toute autre saisie : non proposé (une valeur qu'on ne comprend pas
 * n'ouvre pas un type que personne n'attend).
 */
export function lireTypeActif(valeur: string | null | undefined, defaut: boolean): boolean {
  if (valeur === null || valeur === undefined) return defaut;
  const lue = valeur.trim().toUpperCase();
  if (lue === '') return defaut;
  return lue === '1' || lue === 'TRUE' || lue === 'OUI';
}

/**
 * Canaux où un type est proposé. Liste de canaux (`APP,WEB`, `APP`, `WEB`) ;
 * « 1 », « true », « oui » : les deux ; vide ou absent : la valeur par défaut
 * du type. Tout mot qu'on ne comprend pas est ignoré : « 0 », ou une saisie
 * illisible, ne propose le type nulle part.
 */
export function lireCanauxDuType(
  valeur: string | null | undefined,
  defaut: readonly CanalClient[],
): CanalClient[] {
  if (valeur === null || valeur === undefined) return [...defaut];
  const lue = valeur.trim().toUpperCase();
  if (lue === '') return [...defaut];
  if (lue === '1' || lue === 'TRUE' || lue === 'OUI') return [...CANAUX_CLIENT];
  const coches = new Set(
    lue
      .split(/[\s,;+|]+/)
      .map((mot) => MOTS_DU_CANAL[mot])
      .filter((canal): canal is CanalClient => !!canal),
  );
  return CANAUX_CLIENT.filter((canal) => coches.has(canal));
}

/** Mode de paiement lu ; absent ou illisible : `defaut`. */
export function lirePaiement(
  valeur: string | null | undefined,
  defaut: PaiementCommande = PAIEMENT_PAR_DEFAUT,
): PaiementCommande {
  const lue = (valeur ?? '').trim().toUpperCase();
  return (PAIEMENTS_COMMANDE as readonly string[]).includes(lue) ? (lue as PaiementCommande) : defaut;
}

/**
 * Paiement d'un type. La livraison, tant que son réglage n'a pas été
 * enregistré, reprend l'ancien réglage du site : proposé (ou absent), « en
 * ligne ou à la livraison » ; coupé, en ligne seulement.
 */
function paiementDuType(type: OrderType, valeurs: Record<string, string | null | undefined>): PaiementCommande {
  const defaut: PaiementCommande =
    type === OrderType.DELIVERY && paiementLivraisonActif(valeurs[REGLAGE_PAIEMENT_LIVRAISON_SITE])
      ? 'LES_DEUX'
      : PAIEMENT_PAR_DEFAUT;
  return lirePaiement(valeurs[REGLAGES_TYPES[type].paiement], defaut);
}

/** « Directe » ou « après confirmation » ; absent ou illisible : après confirmation. */
export function lireModeReception(valeur: string | null | undefined): ModeReception {
  const lue = (valeur ?? '').trim().toUpperCase();
  return lue === 'DIRECTE' || lue === 'APRES_CONFIRMATION' ? lue : RECEPTION_PAR_DEFAUT;
}

/** Le réglage lu dans l'ensemble des valeurs. */
export function modeReception(valeurs: Record<string, string | null | undefined>): ModeReception {
  return lireModeReception(valeurs[REGLAGE_RECEPTION]);
}

/**
 * Les réglages des trois types, VUS D'UN CANAL : un type n'est proposé que
 * sur les canaux cochés au back-office. `livraisonCoupee` : la coupure
 * temporaire de la livraison (`delivery.app_disabled`), qui retire la
 * livraison des deux canaux, avec son message.
 *
 * `canal` absent : l'application (les appelants d'avant les cases à cocher).
 */
export function reglagesCommande(
  valeurs: Record<string, string | null | undefined>,
  livraisonCoupee?: { disabled: boolean; message: string } | null,
  canal: CanalClient = 'APP',
): ReglagesCommande {
  const lire = (type: OrderType): TypeCommande => {
    let actif = lireCanauxDuType(valeurs[REGLAGES_TYPES[type].actif], CANAUX_PAR_DEFAUT[type]).includes(canal);
    let message: string | null = actif
      ? null
      : `${NOM_DU_TYPE[type]} n'est pas proposée pour le moment. Choisissez un autre mode de réception.`;
    if (type === OrderType.DELIVERY && actif && livraisonCoupee?.disabled) {
      actif = false;
      message = livraisonCoupee.message;
    }
    return { actif, paiement: paiementDuType(type, valeurs), message };
  };
  return {
    [OrderType.DELIVERY]: lire(OrderType.DELIVERY),
    [OrderType.PICKUP]: lire(OrderType.PICKUP),
    [OrderType.TABLE]: lire(OrderType.TABLE),
  };
}

/** Où le client paie « à la réception », selon le type. */
function lieuDuPaiement(type: OrderType): string {
  return type === OrderType.DELIVERY ? 'à la livraison' : 'au restaurant';
}

/**
 * Refus de `createv2` pour une commande de l'application ou du site, ou `null`
 * si elle est permise. Un moyen de paiement absent vaut « à la réception »,
 * comme le reste de `createv2`.
 */
export function refusCommande(
  reglages: ReglagesCommande,
  type: OrderType,
  payment_method: PaymentMethod | null | undefined,
  canal?: OrderChannel | null,
): string | null {
  const reglage = reglages[type];
  if (!reglage) return 'Type de commande non supporté';
  if (!reglage.actif) return reglage.message ?? `${NOM_DU_TYPE[type]} n'est pas proposée pour le moment.`;

  const moyen = payment_method ?? PaymentMethod.OFFLINE;
  if (reglage.paiement === 'EN_LIGNE' && moyen !== PaymentMethod.ONLINE) {
    return 'Pour ce mode de réception, le paiement se fait en ligne.';
  }
  if (reglage.paiement === 'A_LA_RECEPTION' && moyen !== PaymentMethod.OFFLINE) {
    const base = `Pour ce mode de réception, le paiement se fait ${lieuDuPaiement(type)}.`;
    // Une application plus ancienne ne propose pas ce choix : on le lui dit.
    return canal === OrderChannel.WEB ? base : `${base} Mettez l'application à jour si ce choix n'apparaît pas.`;
  }
  return null;
}

/** Ce que devient la commande à sa création. */
export interface ParcoursCommande {
  /** Elle part au restaurant tout de suite, acceptée. */
  directe: boolean;
  /** Elle attend l'appel du centre d'appels (`Order.a_confirmer`). */
  aConfirmer: boolean;
}

/**
 * Parcours d'une commande de l'application ou du site, selon son moyen de
 * paiement et le réglage. En ligne : ni l'un ni l'autre, elle attend son
 * paiement comme avant.
 */
export function parcoursCommande(
  payment_method: PaymentMethod | null | undefined,
  reception: ModeReception,
): ParcoursCommande {
  const aLaReception = (payment_method ?? PaymentMethod.OFFLINE) === PaymentMethod.OFFLINE;
  return {
    directe: aLaReception && reception === 'DIRECTE',
    aConfirmer: aLaReception && reception === 'APRES_CONFIRMATION',
  };
}
