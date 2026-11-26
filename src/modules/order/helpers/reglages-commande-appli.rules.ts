import { OrderType, PaymentMethod } from '@prisma/client';

/**
 * TYPES DE COMMANDE ET PAIEMENT DANS L'APPLICATION, RÉGLÉS AU BACK-OFFICE
 * (demande du 26/11) : « contrôler depuis le back-office les types de
 * commandes, livraison, à emporter et sur place ; quand j'active sur le
 * back-office cela active sur l'application », et pour chaque type le
 * paiement : à la réception, en ligne seulement, ou les deux.
 *
 * Paramètres > Commandes (clés `order_*_appli`) :
 *  - `order_type_<type>_appli` : « 1 » le type est proposé dans l'application,
 *    « 0 » il ne l'est pas ;
 *  - `order_paiement_<type>_appli` : `EN_LIGNE`, `A_LA_RECEPTION` ou
 *    `LES_DEUX`.
 *
 * Clé absente : ce que l'application faisait avant ces réglages. Livraison et
 * à emporter proposés, sur place non ; paiement en ligne seulement.
 *
 * L'application lit ces réglages par `GET /orders/conditions-commande`
 * (`appli.types`) et n'affiche que ce qui est permis ; `createv2` les
 * contrôle à la création (canal APP), seule vraie garantie : une version de
 * l'application plus ancienne ne les lit pas et reçoit alors le refus en
 * clair. Le site et le centre d'appels ne sont pas concernés.
 *
 * Une commande de l'application à payer à la réception va DIRECTEMENT au
 * restaurant (décision du client, 26/11). Seule la commande du site passe
 * d'abord par le centre d'appels (`paiement-livraison.rules.ts`).
 *
 * Fonctions pures : testées sans base.
 */

/** Moyens de paiement permis pour un type de commande. */
export type PaiementAppli = 'EN_LIGNE' | 'A_LA_RECEPTION' | 'LES_DEUX';

export const PAIEMENTS_APPLI: readonly PaiementAppli[] = ['EN_LIGNE', 'A_LA_RECEPTION', 'LES_DEUX'];

/** Clés des réglages, par type de commande. */
export const REGLAGES_TYPES_APPLI: Record<OrderType, { actif: string; paiement: string }> = {
  [OrderType.DELIVERY]: { actif: 'order_type_livraison_appli', paiement: 'order_paiement_livraison_appli' },
  [OrderType.PICKUP]: { actif: 'order_type_emporter_appli', paiement: 'order_paiement_emporter_appli' },
  [OrderType.TABLE]: { actif: 'order_type_sur_place_appli', paiement: 'order_paiement_sur_place_appli' },
};

/** Toutes les clés à lire d'un coup. */
export const CLES_REGLAGES_COMMANDE_APPLI: string[] = Object.values(REGLAGES_TYPES_APPLI).flatMap((c) => [
  c.actif,
  c.paiement,
]);

/** Clé absente : l'application d'avant ces réglages proposait la livraison et le retrait, pas « sur place ». */
const ACTIF_PAR_DEFAUT: Record<OrderType, boolean> = {
  [OrderType.DELIVERY]: true,
  [OrderType.PICKUP]: true,
  [OrderType.TABLE]: false,
};

/** Clé absente : l'application d'avant ces réglages ne payait qu'en ligne. */
export const PAIEMENT_PAR_DEFAUT: PaiementAppli = 'EN_LIGNE';

/** Nom du type dans les messages au client. */
const NOM_DU_TYPE: Record<OrderType, string> = {
  [OrderType.DELIVERY]: 'La livraison',
  [OrderType.PICKUP]: 'La commande à emporter',
  [OrderType.TABLE]: 'La commande sur place',
};

export interface TypeCommandeAppli {
  /** Le type est proposé dans l'application. */
  actif: boolean;
  paiement: PaiementAppli;
  /** Pourquoi le type n'est pas proposé (affiché tel quel) ; `null` s'il l'est. */
  message: string | null;
}

export type ReglagesCommandeAppli = Record<OrderType, TypeCommandeAppli>;

/**
 * « 1 », « true », « oui » : proposé. Vide ou absent : la valeur par défaut du
 * type. Toute autre saisie : non proposé (une valeur qu'on ne comprend pas
 * n'ouvre pas un type que personne n'attend).
 */
export function lireTypeActif(valeur: string | null | undefined, defaut: boolean): boolean {
  if (valeur === null || valeur === undefined) return defaut;
  const lue = valeur.trim().toLowerCase();
  if (lue === '') return defaut;
  return lue === '1' || lue === 'true' || lue === 'oui';
}

/** Mode de paiement lu ; absent ou illisible : en ligne seulement (le comportement d'avant). */
export function lirePaiementAppli(valeur: string | null | undefined): PaiementAppli {
  const lue = (valeur ?? '').trim().toUpperCase();
  return (PAIEMENTS_APPLI as readonly string[]).includes(lue) ? (lue as PaiementAppli) : PAIEMENT_PAR_DEFAUT;
}

/**
 * Les réglages des trois types. `livraisonCoupee` : la coupure temporaire de
 * la livraison (Paramètres > Livraison, `delivery.app_disabled`), qui retire
 * aussi la livraison, avec son message.
 */
export function reglagesCommandeAppli(
  valeurs: Record<string, string | null | undefined>,
  livraisonCoupee?: { disabled: boolean; message: string } | null,
): ReglagesCommandeAppli {
  const lire = (type: OrderType): TypeCommandeAppli => {
    const cles = REGLAGES_TYPES_APPLI[type];
    let actif = lireTypeActif(valeurs[cles.actif], ACTIF_PAR_DEFAUT[type]);
    let message: string | null = actif
      ? null
      : `${NOM_DU_TYPE[type]} n'est pas proposée pour le moment. Choisissez un autre mode de réception.`;
    if (type === OrderType.DELIVERY && actif && livraisonCoupee?.disabled) {
      actif = false;
      message = livraisonCoupee.message;
    }
    return { actif, paiement: lirePaiementAppli(valeurs[cles.paiement]), message };
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
 * Refus de `createv2` pour une commande de l'application, ou `null` si elle
 * est permise. Un moyen de paiement absent vaut « à la réception », comme le
 * reste de `createv2`.
 */
export function refusCommandeAppli(
  reglages: ReglagesCommandeAppli,
  type: OrderType,
  payment_method: PaymentMethod | null | undefined,
): string | null {
  const reglage = reglages[type];
  if (!reglage) return 'Type de commande non supporté';
  if (!reglage.actif) return reglage.message ?? `${NOM_DU_TYPE[type]} n'est pas proposée pour le moment.`;

  const moyen = payment_method ?? PaymentMethod.OFFLINE;
  if (reglage.paiement === 'EN_LIGNE' && moyen !== PaymentMethod.ONLINE) {
    return 'Pour ce mode de réception, le paiement se fait en ligne.';
  }
  if (reglage.paiement === 'A_LA_RECEPTION' && moyen !== PaymentMethod.OFFLINE) {
    return `Pour ce mode de réception, le paiement se fait ${lieuDuPaiement(type)}. Mettez l'application à jour si ce choix n'apparaît pas.`;
  }
  return null;
}
