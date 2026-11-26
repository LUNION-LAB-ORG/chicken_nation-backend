import type { IDeliveryFeeTier } from './delivery-fee.helper';
import type { ModeReception, ReglagesCommande } from './reglages-commande.rules';

/**
 * CONDITIONS DE COMMANDE PUBLIQUES (05/10/2026).
 *
 * Réponse de `GET /orders/conditions-commande`, lue SANS connexion par le
 * site avant la création de la commande :
 *
 *  - `taux_frais_service` : le réglage `order_tax_rate` tel que `createv2` le
 *    lit (`OrderV2Helper.getTaxRate`). Le serveur facture
 *    `ceil(sous-total × taux / 10) × 10`, le sous-total étant celui des plats,
 *    options et suppléments AVANT remises (cadeaux à 0). `null` quand le
 *    réglage est illisible : le site écrit alors « calculés au paiement »
 *    plutôt qu'un montant faux ;
 *  - `grille_frais` : la grille `delivery.fee_grid`, telle que
 *    `DeliveryFeeHelper.priceForDistance` la FACTURE (voir `grillePublique`) ;
 *  - `grille_frais_appliquee` : faux quand les zones du livreur passent avant
 *    la grille (`delivery.turbo_zones_enabled`, actif par défaut). La grille
 *    ne sert alors que de secours et le prix vient de la zone : l'afficher
 *    comme un tarif serait une promesse fausse. Le site décide (masquer, ou
 *    présenter comme indicative) ;
 *  - `types` (26/11) : pour l'application ET le site, chaque type de commande
 *    (`DELIVERY`, `PICKUP`, `TABLE`) avec `actif`, `paiement` (`EN_LIGNE`,
 *    `A_LA_RECEPTION`, `LES_DEUX`) et, s'il n'est pas proposé, `message`
 *    (`reglages-commande.rules.ts`). Un serveur plus ancien n'envoie pas ce
 *    champ : chacun garde alors livraison et à emporter, en ligne ;
 *  - `reception` (26/11) : `DIRECTE` ou `APRES_CONFIRMATION`, ce que devient
 *    une commande à payer à la réception. Sert à dire au client, avant qu'il
 *    commande, s'il sera appelé pour confirmer ;
 *  - `paiement_livraison.disponible` : gardé pour le site déjà en ligne, qui
 *    ne lit que lui. Vrai quand une livraison peut se payer à la livraison
 *    (`types.DELIVERY.paiement` autre que `EN_LIGNE`) ;
 *  - `appli.types` : le même contenu que `types`, sous le nom que lit
 *    l'application construite le 26/11.
 *
 * Rien d'autre que les frais et la disponibilité du paiement à la livraison :
 * ni service de livraison par restaurant, ni clé, ni offre. Le prix réel d'une adresse reste donné par `/orders/frais-livraison`, et le
 * montant payé par la commande créée.
 */
export interface PalierPublic {
  /** Borne haute du palier, en km PAR LA ROUTE ; `null` = au-delà du palier précédent. */
  distance_max_km: number | null;
  /** Frais de livraison du palier, en FCFA. */
  montant: number;
}

export interface ConditionsCommande {
  taux_frais_service: number | null;
  grille_frais: PalierPublic[];
  grille_frais_appliquee: boolean;
  /** Une livraison peut se payer à la livraison (lu par le site déjà en ligne). */
  paiement_livraison: { disponible: boolean };
  /** Types de commande et paiement permis SUR LE SITE (canaux cochés au back-office). */
  types: ReglagesCommande;
  /** Ce que devient une commande à payer à la réception. */
  reception: ModeReception;
  /** Types de commande et paiement permis DANS L'APPLICATION. */
  appli: { types: ReglagesCommande };
}

/** Taux publié : un nombre fini et positif, sinon `null` (réglage mal saisi). */
export function tauxPublic(taux: number | null | undefined): number | null {
  return typeof taux === 'number' && Number.isFinite(taux) && taux >= 0 ? taux : null;
}

/**
 * La grille telle qu'elle est facturée, palier par palier.
 *
 * `priceForDistance` trie les paliers (`null` en dernier) et prend le premier
 * dont la borne couvre la distance ; au-delà de la dernière borne, il prend
 * le dernier prix. D'où trois redressements, pour que chaque ligne affichée
 * soit exactement ce qui sera facturé :
 *
 *  - un palier à la même borne qu'un précédent n'est jamais atteint : retiré ;
 *  - une borne illisible (non finie, nulle ou négative) n'est jamais atteinte
 *    non plus : retirée ;
 *  - sans palier « au-delà », le dernier prix vaut pour toute distance
 *    supérieure : la dernière borne devient `null`.
 *
 * Un prix nul ou négatif n'est jamais facturé : le verrou de
 * `calculeFraisLivraison` le remplace par la grille par défaut, distance par
 * distance. Une telle grille ne se résume pas en paliers : on n'en publie
 * aucune (liste vide), le site n'affiche alors pas de grille.
 */
export function grillePublique(grille: readonly IDeliveryFeeTier[] | null | undefined): PalierPublic[] {
  if (!Array.isArray(grille) || grille.length === 0) return [];

  const borne = (p: IDeliveryFeeTier) => (p.maxKm == null ? Number.POSITIVE_INFINITY : p.maxKm);
  const lisibles = grille.filter(
    (p) => p.maxKm == null || (typeof p.maxKm === 'number' && Number.isFinite(p.maxKm) && p.maxKm > 0),
  );
  // Même tri que DeliveryFeeHelper.sortGrid (stable : à borne égale, le premier saisi gagne).
  const tries = [...lisibles].sort((a, b) => borne(a) - borne(b));

  const paliers: PalierPublic[] = [];
  let precedente = 0;
  for (const palier of tries) {
    const b = borne(palier);
    if (b <= precedente) continue;
    const montant = Number(palier.price);
    if (!Number.isFinite(montant) || montant <= 0) return [];
    paliers.push({ distance_max_km: palier.maxKm == null ? null : b, montant });
    precedente = b;
  }

  if (paliers.length > 0) paliers[paliers.length - 1].distance_max_km = null;
  return paliers;
}

export function conditionsCommandePubliques(reglages: {
  tauxFraisService: number | null | undefined;
  grille: readonly IDeliveryFeeTier[] | null | undefined;
  zonesLivreurActives: boolean;
  /** Ce que le site peut proposer. */
  types: ReglagesCommande;
  /** Ce que l'application peut proposer ; absent : comme le site. */
  typesAppli?: ReglagesCommande;
  reception: ModeReception;
}): ConditionsCommande {
  return {
    taux_frais_service: tauxPublic(reglages.tauxFraisService),
    grille_frais: grillePublique(reglages.grille),
    grille_frais_appliquee: !reglages.zonesLivreurActives,
    paiement_livraison: { disponible: reglages.types.DELIVERY.paiement !== 'EN_LIGNE' },
    types: reglages.types,
    reception: reglages.reception,
    appli: { types: reglages.typesAppli ?? reglages.types },
  };
}
