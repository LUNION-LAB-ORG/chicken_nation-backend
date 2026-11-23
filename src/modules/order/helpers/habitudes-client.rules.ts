import { OrderType } from '@prisma/client';

/**
 * HABITUDES D'UN CLIENT À LA PRISE DE COMMANDE (23/11).
 *
 * L'agent identifie le client, l'écran lui montre ce qu'il commande
 * d'habitude et sa dernière commande, pour proposer « comme d'habitude ? »
 * et remplir le panier en un geste.
 *
 * Règles pures, sans base : le service lit les commandes et le catalogue du
 * jour, ce fichier décide.
 */

/** Commandes relues, les plus récentes : au-delà, ce n'est plus une habitude. */
export const HABITUDES_FENETRE = 30;
/** Plats habituels montrés, au plus. */
export const HABITUDES_PLATS_MAX = 6;
/** Un plat devient une habitude à partir de deux commandes. */
export const HABITUDES_FOIS_MIN = 2;

export type SupplementRepris = { id: string; quantity: number };

/** Ligne d'une commande passée, telle que la base la rend. */
export type LigneCommandeLue = {
  dish_id: string;
  quantity: number;
  /** Prix unitaire facturé : zéro pour un plat offert (cadeau). */
  amount: number;
  epice: boolean;
  /** Json figé à la commande : `[{ id, name, price, quantity, category }]`. */
  supplements: unknown;
  /** Json figé à la commande : `[{ id, label, group_name, price_delta }]`. */
  options: unknown;
  dish: { name: string; image: string | null } | null;
};

/** Commande passée, la plus récente d'abord dans la liste remise aux règles. */
export type CommandeLue = {
  id: string;
  reference: string;
  created_at: Date;
  type: OrderType;
  amount: number;
  restaurant: { id: string; name: string } | null;
  order_items: LigneCommandeLue[];
};

/** Ce que le catalogue du jour permet encore à CE client. */
export type CatalogueDuJour = {
  /** Plats encore au menu pour lui : actifs, non privés, dans son audience. */
  plats: ReadonlySet<string>;
  /** Suppléments encore disponibles. */
  supplements: ReadonlySet<string>;
  /** Suppléments exclus d'un plat, clés {@link cleExclusion}. */
  exclusions: ReadonlySet<string>;
};

export type PlatHabituel = {
  dish_id: string;
  nom: string;
  image: string | null;
  /** Nombre de commandes où le plat figure, parmi celles relues. */
  fois: number;
  derniere_le: Date;
  /** Sa dernière façon de le commander. */
  epice: boolean;
  supplements: SupplementRepris[];
  option_item_ids: string[];
};

export type LigneDerniereCommande = {
  dish_id: string;
  nom: string;
  quantity: number;
  epice: boolean;
  supplements: SupplementRepris[];
  option_item_ids: string[];
  /** Faux : le plat n'est plus au menu pour ce client, la ligne ne se reprend pas. */
  disponible: boolean;
};

export type DerniereCommande = {
  id: string;
  reference: string;
  le: Date;
  type: OrderType;
  montant: number;
  restaurant: { id: string; name: string } | null;
  lignes: LigneDerniereCommande[];
};

export type HabitudesClient = {
  /** Commandes relues ({@link HABITUDES_FENETRE} au plus). */
  commandes: number;
  /** Les plus commandés d'abord, {@link HABITUDES_PLATS_MAX} au plus. */
  plats: PlatHabituel[];
  derniere: DerniereCommande | null;
};

export const HABITUDES_VIDES: HabitudesClient = { commandes: 0, plats: [], derniere: null };

export const cleExclusion = (dishId: string, supplementId: string): string => `${dishId}:${supplementId}`;

/**
 * Suppléments d'une ligne passée. Le Json a changé de forme avec le temps
 * (identifiant seul, objet sans quantité) : tout ce qui n'a pas d'identifiant
 * est ignoré, une quantité absente ou invalide vaut 1, un doublon s'additionne.
 */
export function lireSupplements(brut: unknown): SupplementRepris[] {
  if (!Array.isArray(brut)) return [];
  const parId = new Map<string, number>();
  for (const element of brut) {
    const id = typeof element === 'string' ? element : (element as { id?: unknown } | null)?.id;
    if (typeof id !== 'string' || id === '') continue;
    const lue = Number((element as { quantity?: unknown } | null)?.quantity);
    const quantite = Number.isInteger(lue) && lue > 0 ? lue : 1;
    parId.set(id, (parId.get(id) ?? 0) + quantite);
  }
  return [...parId].map(([id, quantity]) => ({ id, quantity }));
}

/** Identifiants des choix d'un plat composable, sans doublon. */
export function lireOptions(brut: unknown): string[] {
  if (!Array.isArray(brut)) return [];
  const ids = brut
    .map((element) => (element as { id?: unknown } | null)?.id)
    .filter((id): id is string => typeof id === 'string' && id !== '');
  return [...new Set(ids)];
}

/**
 * Une ligne compte si le client l'a payée. Un plat offert (lot, parrainage :
 * prix unitaire à zéro) n'est pas une habitude, et le reprendre le
 * facturerait.
 */
function ligneComptee(ligne: LigneCommandeLue): boolean {
  return ligne.quantity > 0 && ligne.amount > 0;
}

/** Suppléments d'une ligne encore vendables avec ce plat aujourd'hui. */
function supplementsRepris(ligne: LigneCommandeLue, catalogue: CatalogueDuJour): SupplementRepris[] {
  return lireSupplements(ligne.supplements).filter(
    (s) => catalogue.supplements.has(s.id) && !catalogue.exclusions.has(cleExclusion(ligne.dish_id, s.id)),
  );
}

/**
 * Plats habituels et dernière commande.
 *
 * `commandes` : les commandes qui comptent du client, la plus récente
 * d'abord. Un plat compte une fois par commande, quelle que soit sa quantité.
 * Sa « dernière façon » est celle de la commande la plus récente.
 *
 * Un plat retiré du menu, ou qui n'est plus dans l'audience du client, sort
 * des habitudes : le serveur refuserait la commande. Il reste lisible dans la
 * dernière commande, marqué indisponible.
 */
export function etablirHabitudes(commandes: readonly CommandeLue[], catalogue: CatalogueDuJour): HabitudesClient {
  const parPlat = new Map<string, { fois: number; derniere_le: Date; ligne: LigneCommandeLue }>();
  for (const commande of commandes) {
    const vus = new Set<string>();
    for (const ligne of commande.order_items) {
      if (!ligneComptee(ligne) || vus.has(ligne.dish_id)) continue;
      vus.add(ligne.dish_id);
      const connu = parPlat.get(ligne.dish_id);
      if (connu) connu.fois += 1;
      else parPlat.set(ligne.dish_id, { fois: 1, derniere_le: commande.created_at, ligne });
    }
  }

  const plats: PlatHabituel[] = [...parPlat]
    .filter(([dishId, p]) => p.fois >= HABITUDES_FOIS_MIN && catalogue.plats.has(dishId))
    .sort(
      ([, a], [, b]) =>
        b.fois - a.fois ||
        b.derniere_le.getTime() - a.derniere_le.getTime() ||
        (a.ligne.dish?.name ?? '').localeCompare(b.ligne.dish?.name ?? '', 'fr'),
    )
    .slice(0, HABITUDES_PLATS_MAX)
    .map(([dishId, p]) => ({
      dish_id: dishId,
      nom: p.ligne.dish?.name ?? '',
      image: p.ligne.dish?.image ?? null,
      fois: p.fois,
      derniere_le: p.derniere_le,
      epice: p.ligne.epice,
      supplements: supplementsRepris(p.ligne, catalogue),
      option_item_ids: lireOptions(p.ligne.options),
    }));

  // La plus récente qui a au moins une ligne payée.
  const recente = commandes.find((commande) => commande.order_items.some(ligneComptee));
  const derniere: DerniereCommande | null = recente
    ? {
        id: recente.id,
        reference: recente.reference,
        le: recente.created_at,
        type: recente.type,
        montant: recente.amount,
        restaurant: recente.restaurant,
        lignes: recente.order_items.filter(ligneComptee).map((ligne) => ({
          dish_id: ligne.dish_id,
          nom: ligne.dish?.name ?? '',
          quantity: ligne.quantity,
          epice: ligne.epice,
          supplements: supplementsRepris(ligne, catalogue),
          option_item_ids: lireOptions(ligne.options),
          disponible: catalogue.plats.has(ligne.dish_id),
        })),
      }
    : null;

  return { commandes: commandes.length, plats, derniere };
}
