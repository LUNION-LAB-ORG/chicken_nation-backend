import { DiscountType, TargetType, VoucherStatus } from '@prisma/client';

/**
 * RÉDUCTION À LA PRISE DE COMMANDE (code promo ou bon d'achat) : fonctions
 * pures, partagées par l'aperçu et par la création. Si l'une calculait
 * autrement que l'autre, l'écran afficherait une remise et la commande en
 * enregistrerait une autre.
 */

/** Longueur maximale d'un code saisi (codes promo et bons). */
export const LONGUEUR_MAX_CODE = 64;

/** Un bon expiré qu'on recrédite repart pour cette durée (décision du 25/09). */
export const JOURS_PROLONGATION_BON = 30;

/** Même texte que l'écran : un code valide qui ne retire rien est refusé. */
export const MESSAGE_SANS_REDUCTION = 'Ce code ne donne aucune réduction sur cette commande.';

export const MESSAGE_AUCUN_COUPON = 'Aucun code promo ni bon ne correspond à ce code.';

/** Majuscules, sans espaces autour. Chaîne vide si rien n'est saisi. */
export function normaliserCode(code?: string | null): string {
  return typeof code === 'string' ? code.trim().toUpperCase() : '';
}

/** « 2 000 » : arrondi au franc, séparateur de milliers français. */
export function formaterFrancs(montant: number): string {
  return Math.round(Number(montant) || 0).toLocaleString('fr-FR');
}

/**
 * Remise arrondie au franc, jamais négative et jamais au-delà du plafond.
 *
 * Les soldes de bons sont des nombres à virgule : arrondir 1 500,6 à 1 501
 * donnerait un débit supérieur au solde, que la consommation refuserait. On
 * arrondit donc au plus proche, sauf si cela dépasse le plafond : alors on
 * arrondit vers le bas.
 */
export function arrondirRemise(brute: number, plafond: number): number {
  const cap = Math.max(0, Number(plafond) || 0);
  const borne = Math.max(0, Math.min(Number(brute) || 0, cap));
  const proche = Math.round(borne);
  return proche <= cap + 1e-6 ? proche : Math.floor(cap + 1e-6);
}

/** Montant affiché d'un solde, sans bruit de virgule flottante. */
export function arrondirSolde(solde: number): number {
  return Math.max(0, Math.round((Number(solde) || 0) * 100) / 100);
}

/**
 * Code masqué pour la liste des bons du client : les deux premiers et les deux
 * derniers caractères seulement. Sur un bon « CN » + 6 caractères, il reste 4
 * caractères inconnus, soit près d'un million de possibilités : l'agent ne peut
 * pas le deviner, le client doit le dicter (décision du 25/09).
 */
export function masquerCode(code: string): string {
  const c = (code ?? '').trim();
  if (c.length <= 4) return '••••';
  const caches = Math.min(Math.max(c.length - 4, 2), 6);
  return `${c.slice(0, 2)}${'•'.repeat(caches)}${c.slice(-2)}`;
}

/** Ligne de l'assiette des remises : plats ET options, suppléments exclus. */
export interface LigneAssiette {
  dish_id: string;
  quantity: number;
  price: number;
}

/**
 * Assiette des remises, UNE source pour l'aperçu et la création : prix du plat
 * plus options du menu composable, suppléments à la carte exclus.
 */
export function assietteDesRemises(
  orderItems: { dish_id: string; quantity: number; dishPrice: number; optionsUnitPrice?: number }[],
): LigneAssiette[] {
  return orderItems.map((item) => ({
    dish_id: item.dish_id,
    quantity: item.quantity,
    price: item.dishPrice + (item.optionsUnitPrice ?? 0),
  }));
}

/** Phrase prête à afficher pour un code promo (sans point final). */
export function libelleCodePromo(p: {
  discount_type: DiscountType;
  discount_value: number;
  max_discount_amount?: number | null;
  target_type: TargetType;
}): string {
  const cible =
    p.target_type === TargetType.ALL_PRODUCTS ? 'sur la commande' : 'sur les articles concernés';
  if (p.discount_type === DiscountType.PERCENTAGE) {
    const taux = Number(p.discount_value).toLocaleString('fr-FR', { maximumFractionDigits: 2 });
    const plafond = p.max_discount_amount
      ? `, dans la limite de ${formaterFrancs(p.max_discount_amount)} F`
      : '';
    return `${taux} % ${cible}${plafond}`;
  }
  // FIXED_AMOUNT, et BUY_X_GET_Y que le moteur calcule comme un montant fixe.
  return `remise de ${formaterFrancs(p.discount_value)} F ${cible}`;
}

export const LIBELLE_BON = "Bon d'achat";

/**
 * Motif de refus d'un bon pour le personnel, ou null s'il est utilisable. Le
 * propriétaire et l'existence sont contrôlés avant.
 */
export function motifRefusBon(
  bon: { status: VoucherStatus; expires_at: Date | null; remaining_amount: number },
  maintenant: Date,
): string | null {
  if (bon.status === VoucherStatus.CANCELLED) return 'Ce bon a été annulé.';
  if (bon.status === VoucherStatus.REDEEMED) return 'Ce bon est épuisé.';
  if (
    bon.status === VoucherStatus.EXPIRED ||
    (bon.expires_at && new Date(bon.expires_at).getTime() <= maintenant.getTime())
  ) {
    return 'Ce bon a expiré.';
  }
  if (bon.status !== VoucherStatus.ACTIVE) return "Ce bon n'est plus actif.";
  // Moins d'un franc : rien à déduire au franc près.
  if ((Number(bon.remaining_amount) || 0) < 1) return 'Ce bon est épuisé.';
  return null;
}

/**
 * Les refus du moteur des codes promo sont écrits pour le CLIENT de l'app
 * (« Vous avez déjà utilisé… »). L'agent, lui, parle AU client : on reformule
 * ceux qui le méritent et on garde les autres, avec un point final.
 */
export function reformulerRefusCodePromo(message: string): string {
  const texte = (message ?? '').trim();
  if (/^Vous avez déjà utilisé/.test(texte)) {
    return 'Ce client a déjà utilisé ce code promo le nombre maximum de fois.';
  }
  const minimum = /^Le montant minimum de commande est de ([\d.]+) FCFA$/.exec(texte);
  if (minimum) {
    return `Le montant minimum de commande pour ce code est de ${formaterFrancs(Number(minimum[1]))} F, hors livraison.`;
  }
  if (/^Ce code promo ne s'applique à aucun produit/.test(texte)) {
    return "Ce code promo ne s'applique à aucun article de cette commande.";
  }
  if (!texte) return "Ce code promo n'a pas pu être vérifié.";
  return /[.!?]$/.test(texte) ? texte : `${texte}.`;
}
