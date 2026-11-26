import { OrderChannel, OrderType, PaymentMethod } from '@prisma/client';

import { REGLAGE_PAIEMENT_LIVRAISON_SITE } from './paiement-livraison.rules';

/**
 * TYPES DE COMMANDE ET PAIEMENT, RÉGLÉS AU BACK-OFFICE : UN PARAMÉTRAGE POUR
 * L'APPLICATION, UN PARAMÉTRAGE POUR LE SITE (demandes du 26/11).
 *
 * Le client a d'abord demandé de « contrôler depuis le back-office les types
 * de commandes, livraison, à emporter et sur place », et pour chaque type le
 * paiement : à la réception, en ligne seulement, ou les deux. Puis, le même
 * jour, après plusieurs allers et retours : « on doit avoir le paramétrage
 * pour le site et le paramétrage pour l'appli [...] pareil pour commande à
 * payer à la réception ». Chaque canal a donc SES réglages, de même forme.
 *
 * Paramètres > Vente > Commandes écrit, pour chaque canal (`appli`, `site`) :
 *  - `order_type_<type>_<canal>` : « 1 » le type est proposé, « 0 » non ;
 *  - `order_paiement_<type>_<canal>` : `EN_LIGNE`, `A_LA_RECEPTION` ou
 *    `LES_DEUX` ;
 *  - `order_paiement_reception_<canal>` : ce que devient une commande à payer
 *    à la réception. `DIRECTE` : elle part au restaurant, acceptée.
 *    `APRES_CONFIRMATION` : le centre d'appels l'appelle d'abord
 *    (`paiement-livraison.rules.ts`, commande « à confirmer »).
 *
 * Clés absentes : ce que chaque canal faisait avant ces réglages.
 *  - Application : livraison et à emporter, payés en ligne ; une commande à
 *    payer à la réception part directement au restaurant.
 *  - Site : livraison et à emporter, payés en ligne, la livraison aussi à la
 *    livraison ; une commande à payer à la réception attend la confirmation
 *    du centre d'appels.
 *  - « Sur place » n'est proposé nulle part (le site ne sait pas le vendre).
 *
 * ⚠️ `order_paiement_livraison_site` existait avant (19/10) : « 1 » le
 * paiement à la livraison est proposé sur le site, « 0 » il ne l'est pas.
 * C'est la même clé, lue dans les deux écritures : « 1 » (ou absent) vaut
 * `LES_DEUX`, « 0 » vaut `EN_LIGNE`. Le site ne perd rien au déploiement.
 *
 * L'application et le site lisent leurs réglages par
 * `GET /orders/conditions-commande` et n'affichent que ce qui est permis ;
 * `createv2` les contrôle à la création, seule vraie garantie : une version
 * plus ancienne ne les lit pas et reçoit alors le refus en clair. Le centre
 * d'appels et la caisse ne sont pas concernés.
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

/** Fin de clé d'un canal. */
const SUFFIXE_DU_CANAL: Record<CanalClient, string> = { APP: 'appli', WEB: 'site' };

/** Nom d'un type dans les clés. */
const NOM_DU_TYPE_DANS_LA_CLE: Record<OrderType, string> = {
  [OrderType.DELIVERY]: 'livraison',
  [OrderType.PICKUP]: 'emporter',
  [OrderType.TABLE]: 'sur_place',
};

/** Clé « le type est proposé » d'un canal. */
export const cleType = (type: OrderType, canal: CanalClient): string =>
  `order_type_${NOM_DU_TYPE_DANS_LA_CLE[type]}_${SUFFIXE_DU_CANAL[canal]}`;

/** Clé du paiement permis pour un type, sur un canal. */
export const clePaiement = (type: OrderType, canal: CanalClient): string =>
  `order_paiement_${NOM_DU_TYPE_DANS_LA_CLE[type]}_${SUFFIXE_DU_CANAL[canal]}`;

/** Clé « commande à payer à la réception » d'un canal. */
export const cleReception = (canal: CanalClient): string => `order_paiement_reception_${SUFFIXE_DU_CANAL[canal]}`;

/** Toutes les clés à lire d'un coup, pour les deux canaux. */
export const CLES_REGLAGES_COMMANDE: string[] = CANAUX_CLIENT.flatMap((canal) => [
  ...Object.values(OrderType).flatMap((type) => [cleType(type, canal), clePaiement(type, canal)]),
  cleReception(canal),
]);

/** Clé absente : la livraison et le retrait étaient proposés, pas « sur place ». */
const ACTIF_PAR_DEFAUT: Record<OrderType, boolean> = {
  [OrderType.DELIVERY]: true,
  [OrderType.PICKUP]: true,
  [OrderType.TABLE]: false,
};

/** Clé absente : en ligne seulement (hors livraison sur le site, voir `paiementDuType`). */
export const PAIEMENT_PAR_DEFAUT: PaiementCommande = 'EN_LIGNE';

/**
 * Clé absente : ce que chaque canal faisait. L'application envoyait la
 * commande directement au restaurant (décision du client, 26/11 au matin) ;
 * le site la faisait confirmer par le centre d'appels (19/10).
 */
export const RECEPTION_PAR_DEFAUT: Record<CanalClient, ModeReception> = {
  APP: 'DIRECTE',
  WEB: 'APRES_CONFIRMATION',
};

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

/** Mode de paiement lu ; absent ou illisible : `defaut`. */
export function lirePaiement(
  valeur: string | null | undefined,
  defaut: PaiementCommande = PAIEMENT_PAR_DEFAUT,
): PaiementCommande {
  const lue = (valeur ?? '').trim().toUpperCase();
  return (PAIEMENTS_COMMANDE as readonly string[]).includes(lue) ? (lue as PaiementCommande) : defaut;
}

/**
 * Paiement d'une LIVRAISON SUR LE SITE (`order_paiement_livraison_site`),
 * dans ses deux écritures : la nouvelle (`EN_LIGNE`, `A_LA_RECEPTION`,
 * `LES_DEUX`) et l'ancienne du 19/10 (« 1 », « true », « oui » : le paiement
 * à la livraison est proposé, donc `LES_DEUX`). Absent ou vide : proposé,
 * comme le voulait la décision du 19/10. « 0 », ou une saisie illisible : en
 * ligne seulement.
 */
export function lirePaiementLivraisonSite(valeur: string | null | undefined): PaiementCommande {
  const lue = (valeur ?? '').trim().toUpperCase();
  if (lue === '' || lue === '1' || lue === 'TRUE' || lue === 'OUI') return 'LES_DEUX';
  return lirePaiement(lue, 'EN_LIGNE');
}

/** Paiement d'un type sur un canal. */
function paiementDuType(
  type: OrderType,
  canal: CanalClient,
  valeurs: Record<string, string | null | undefined>,
): PaiementCommande {
  const cle = clePaiement(type, canal);
  // Même clé que l'ancien réglage du site : lue dans ses deux écritures.
  if (cle === REGLAGE_PAIEMENT_LIVRAISON_SITE) return lirePaiementLivraisonSite(valeurs[cle]);
  return lirePaiement(valeurs[cle]);
}

/** « Directe » ou « après confirmation » ; absent ou illisible : `defaut`. */
export function lireModeReception(valeur: string | null | undefined, defaut: ModeReception): ModeReception {
  const lue = (valeur ?? '').trim().toUpperCase();
  return lue === 'DIRECTE' || lue === 'APRES_CONFIRMATION' ? lue : defaut;
}

/** Le parcours d'une commande à payer à la réception, pour un canal. */
export function modeReception(
  valeurs: Record<string, string | null | undefined>,
  canal: CanalClient,
): ModeReception {
  return lireModeReception(valeurs[cleReception(canal)], RECEPTION_PAR_DEFAUT[canal]);
}

/**
 * Les réglages des trois types, POUR UN CANAL. `livraisonCoupee` : la coupure
 * temporaire de la livraison (`delivery.app_disabled`), qui retire la
 * livraison des deux canaux, avec son message.
 */
export function reglagesCommande(
  valeurs: Record<string, string | null | undefined>,
  livraisonCoupee: { disabled: boolean; message: string } | null | undefined,
  canal: CanalClient,
): ReglagesCommande {
  const lire = (type: OrderType): TypeCommande => {
    let actif = lireTypeActif(valeurs[cleType(type, canal)], ACTIF_PAR_DEFAUT[type]);
    let message: string | null = actif
      ? null
      : `${NOM_DU_TYPE[type]} n'est pas proposée pour le moment. Choisissez un autre mode de réception.`;
    if (type === OrderType.DELIVERY && actif && livraisonCoupee?.disabled) {
      actif = false;
      message = livraisonCoupee.message;
    }
    return { actif, paiement: paiementDuType(type, canal, valeurs), message };
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
 * si elle est permise. `reglages` : ceux du canal de la commande. Un moyen de
 * paiement absent vaut « à la réception », comme le reste de `createv2`.
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
 * paiement et le réglage de SON canal. En ligne : ni l'un ni l'autre, elle
 * attend son paiement comme avant.
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
