import { ConflictException } from '@nestjs/common';
import { Prisma, RewardStatus, RewardType } from '@prisma/client';

/**
 * CADEAUX D'UN PANIER ANNULÉ PAR LE CLIENT, à sa réactivation (01/10).
 *
 * L'annulation rend au client les cadeaux (GIFT) offerts sur le panier
 * (`RewardService.restoreConsumedGiftsForOrder` : de nouveau utilisables, lien
 * à la commande effacé). Si la commande réactivée garde ses lignes offertes,
 * chaque cadeau doit être consommé de nouveau, sinon le client l'aurait deux
 * fois : une fois sur cette commande, une fois sur la suivante.
 *
 * Lignes offertes, telles que l'application les écrit (`OrderV2Helper`) :
 *  - plat offert : prix unitaire à 0 F alors que le plat a un prix au
 *    catalogue ;
 *  - supplément offert : marqué `offert` dans les suppléments de la ligne.
 *
 * Lignes recalculées par le formulaire du back office (prix du catalogue) :
 * plus rien n'est offert, rien à reprendre.
 */

export type CadeauRequis = { genre: 'DISH'; dish_id: string } | { genre: 'SUPPLEMENT'; supplement_id: string };

interface LigneLue {
  dish_id: string;
  unit_price?: number | null;
  supplements?: unknown;
  dish?: { price?: number | null } | null;
}

/** Cadeaux que les lignes d'une commande supposent consommés. */
export function cadeauxDesLignes(lignes: LigneLue[] | null | undefined): CadeauRequis[] {
  const requis: CadeauRequis[] = [];
  for (const ligne of lignes ?? []) {
    if (ligne.unit_price === 0 && (ligne.dish?.price ?? 0) > 0) {
      requis.push({ genre: 'DISH', dish_id: ligne.dish_id });
    }
    if (Array.isArray(ligne.supplements)) {
      for (const s of ligne.supplements as { id?: unknown; offert?: unknown }[]) {
        if (s && s.offert === true && typeof s.id === 'string') {
          requis.push({ genre: 'SUPPLEMENT', supplement_id: s.id });
        }
      }
    }
  }
  return requis;
}

type Contenu = Record<string, unknown> | null;

function couvre(requis: CadeauRequis, payload: unknown): boolean {
  const p = (payload && typeof payload === 'object' ? payload : null) as Contenu;
  if (!p) return false;
  if (requis.genre === 'DISH') {
    return (!p.item_type || p.item_type === 'DISH') && p.dish_id === requis.dish_id;
  }
  return p.item_type === 'SUPPLEMENT' && p.supplement_id === requis.supplement_id;
}

export const MESSAGE_CADEAU_INDISPONIBLE =
  "Le cadeau offert sur cette commande n'est plus disponible (utilisé ou expiré depuis l'annulation) : modifiez les articles avant de la reprendre.";

/**
 * Consomme de nouveau, DANS la transaction de la réactivation, un cadeau par
 * ligne offerte. Les cadeaux encore liés à la commande comptent d'abord
 * (jamais rendus). Pour le reste, un cadeau équivalent du client (même plat,
 * même supplément), gratté et non expiré, est revendiqué par une écriture
 * conditionnée (SCRATCHED vers CONSUMED) : deux gestes simultanés n'en
 * prennent jamais un même. Le plus proche de l'expiration d'abord.
 *
 * Lève 409 si un cadeau manque : rien n'est écrit, la transaction entière
 * est annulée. Renvoie les identifiants des cadeaux repris.
 */
export async function reprendreCadeaux(
  tx: Prisma.TransactionClient,
  commande: { id: string; customer_id: string },
  requis: CadeauRequis[],
  maintenant: Date = new Date(),
): Promise<string[]> {
  if (requis.length === 0) return [];

  const lies = await tx.reward.findMany({
    where: { order_id: commande.id, type: RewardType.GIFT, status: RewardStatus.CONSUMED },
    select: { id: true, payload: true },
  });
  const manquants: CadeauRequis[] = [];
  const liesRestants = [...lies];
  for (const r of requis) {
    const i = liesRestants.findIndex((l) => couvre(r, l.payload));
    if (i >= 0) liesRestants.splice(i, 1);
    else manquants.push(r);
  }
  if (manquants.length === 0) return [];

  const candidats = await tx.reward.findMany({
    where: {
      customer_id: commande.customer_id,
      type: RewardType.GIFT,
      status: RewardStatus.SCRATCHED,
      OR: [{ expires_at: null }, { expires_at: { gt: maintenant } }],
    },
    select: { id: true, payload: true, expires_at: true },
  });
  // Le plus proche de l'expiration d'abord, sans date en dernier.
  candidats.sort(
    (a, b) =>
      (a.expires_at?.getTime() ?? Number.MAX_SAFE_INTEGER) - (b.expires_at?.getTime() ?? Number.MAX_SAFE_INTEGER),
  );

  const repris: string[] = [];
  for (const r of manquants) {
    let pris: string | null = null;
    for (const c of candidats) {
      if (repris.includes(c.id) || !couvre(r, c.payload)) continue;
      const { count } = await tx.reward.updateMany({
        where: {
          id: c.id,
          customer_id: commande.customer_id,
          type: RewardType.GIFT,
          status: RewardStatus.SCRATCHED,
          OR: [{ expires_at: null }, { expires_at: { gt: maintenant } }],
        },
        data: { status: RewardStatus.CONSUMED, order_id: commande.id, consumed_at: maintenant, updated_at: maintenant },
      });
      if (count === 1) {
        pris = c.id;
        break;
      }
    }
    if (!pris) throw new ConflictException(MESSAGE_CADEAU_INDISPONIBLE);
    repris.push(pris);
  }
  return repris;
}

// ---------------------------------------------------------------------------
// Articles renvoyés par le formulaire « Modifier la commande » (revue du 01/10)
// ---------------------------------------------------------------------------

/**
 * Le formulaire du back office renvoie TOUJOURS les articles, même quand
 * l'agent n'y a pas touché. Recalculés au prix de la carte, les plats et
 * suppléments offerts seraient alors facturés sans un mot, alors que
 * l'annulation a rendu leurs cadeaux au client. Deux réponses :
 *  - mêmes articles que la commande (`memesArticles`) : la réactivation garde
 *    les lignes d'origine, et les cadeaux sont consommés de nouveau
 *    (`reprendreCadeaux`), ou 409 s'ils ne sont plus disponibles ;
 *  - articles modifiés : lignes recalculées, et chaque cadeau dont le plat ou
 *    le supplément reste au panier est désormais facturé
 *    (`cadeauxRefactures`) : l'agent en est averti, pour l'annoncer.
 */

/** Ligne d'origine d'une commande, avec ce qu'il faut pour la comparer. */
export interface LigneOrigine extends LigneLue {
  quantity?: number | null;
  epice?: boolean | null;
  options?: unknown;
  dish?: { price?: number | null; name?: string | null } | null;
}

/** Article tel que le renvoie le formulaire (`CreateOrderItemDto`). */
export interface ArticleRenvoye {
  dish_id: string;
  quantity: number;
  epice?: boolean | null;
  supplements?: { id: string; quantity?: number | null }[] | null;
  supplements_ids?: string[] | null;
  option_item_ids?: string[] | null;
}

/** Suppléments regroupés par identifiant : « id×quantité », triés. */
function signatureSupplements(liste: { id?: unknown; quantity?: unknown }[]): string {
  const parId = new Map<string, number>();
  for (const s of liste) {
    if (!s || typeof s.id !== 'string') continue;
    const q = Number(s.quantity) > 0 ? Number(s.quantity) : 1;
    parId.set(s.id, (parId.get(s.id) ?? 0) + q);
  }
  return [...parId.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, q]) => `${id}x${q}`)
    .join(',');
}

function idsTries(liste: unknown): string {
  if (!Array.isArray(liste)) return '';
  return liste
    .map((o) => (typeof o === 'string' ? o : (o as { id?: unknown })?.id))
    .filter((v): v is string => typeof v === 'string')
    .sort()
    .join(',');
}

/**
 * Vrai si les articles renvoyés décrivent exactement les lignes de la
 * commande : mêmes plats, quantités, épice et suppléments (avec leurs
 * quantités), mêmes choix de menu quand ils sont transmis (absents, le
 * serveur reprend ceux de la ligne). Dans le doute, faux : les lignes sont
 * alors recalculées et l'agent averti, ce qui ne fait jamais de cadeau.
 */
export function memesArticles(
  lignes: LigneOrigine[] | null | undefined,
  articles: ArticleRenvoye[] | null | undefined,
): boolean {
  const origine = lignes ?? [];
  const envoyes = articles ?? [];
  if (origine.length === 0 || origine.length !== envoyes.length) return false;

  const base = (dish: string, quantite: unknown, epice: unknown, supplements: string) =>
    `${dish}|${Number(quantite)}|${epice === true ? 1 : 0}|${supplements}`;
  const restantes = origine.map((l) => ({
    cle: base(
      l.dish_id,
      l.quantity,
      l.epice,
      signatureSupplements(Array.isArray(l.supplements) ? (l.supplements as { id?: unknown; quantity?: unknown }[]) : []),
    ),
    options: idsTries(l.options),
  }));

  for (const a of envoyes) {
    const supplements = a.supplements?.length
      ? a.supplements
      : (a.supplements_ids ?? []).map((id) => ({ id, quantity: 1 }));
    const cle = base(a.dish_id, a.quantity, a.epice, signatureSupplements(supplements));
    const options = a.option_item_ids?.length ? idsTries(a.option_item_ids) : null;
    const i = restantes.findIndex((r) => r.cle === cle && (options === null || r.options === options));
    if (i < 0) return false;
    restantes.splice(i, 1);
  }
  return true;
}

/**
 * Noms des cadeaux de la commande d'origine que des articles recalculés
 * facturent désormais : le plat ou le supplément offert est encore au
 * panier, au prix de la carte. Un cadeau dont l'article a été retiré n'est
 * facturé nulle part : il n'y figure pas.
 */
export function cadeauxRefactures(
  lignes: LigneOrigine[] | null | undefined,
  articles: ArticleRenvoye[] | null | undefined,
): string[] {
  const envoyes = articles ?? [];
  const plats = new Set(envoyes.map((a) => a.dish_id));
  const supplements = new Set<string>();
  for (const a of envoyes) {
    for (const s of a.supplements ?? []) if (s && typeof s.id === 'string') supplements.add(s.id);
    for (const id of a.supplements_ids ?? []) supplements.add(id);
  }

  const noms: string[] = [];
  for (const ligne of lignes ?? []) {
    for (const requis of cadeauxDesLignes([ligne])) {
      if (requis.genre === 'DISH') {
        if (plats.has(requis.dish_id)) noms.push(ligne.dish?.name?.trim() || 'plat offert');
        continue;
      }
      if (!supplements.has(requis.supplement_id)) continue;
      const s = (Array.isArray(ligne.supplements) ? (ligne.supplements as { id?: unknown; name?: unknown }[]) : []).find(
        (x) => x?.id === requis.supplement_id,
      );
      noms.push((typeof s?.name === 'string' && s.name.trim()) || 'supplément offert');
    }
  }
  return noms;
}
