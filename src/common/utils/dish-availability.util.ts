import { BadRequestException } from '@nestjs/common';
import { OrderType } from '@prisma/client';

/** Plat avec créneau de disponibilité optionnel (« HH:mm », null = toujours dispo). */
interface DishWithWindow {
  name: string;
  available_from?: string | null;
  available_until?: string | null;
}

const parseMinutes = (s: string): number | null => {
  const [h, m] = s.split(':').map((p) => parseInt(p, 10));
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  return h * 60 + m;
};

/**
 * Un plat est disponible si aucun créneau n'est défini, si le créneau est
 * invalide (sécurité : une mauvaise saisie ne doit pas bloquer les ventes),
 * ou si l'heure courante est dans [from, until] — créneau passant minuit géré
 * (ex. 22:00 → 02:00). Fuseau : Côte d'Ivoire = UTC+0 → heure UTC = heure locale.
 */
export function isDishAvailableNow(
  dish: DishWithWindow,
  now: Date = new Date(),
): boolean {
  const { available_from: from, available_until: until } = dish;
  if (!from || !until) return true;
  const start = parseMinutes(from);
  const end = parseMinutes(until);
  if (start === null || end === null || start === end) return true;
  const cur = now.getUTCHours() * 60 + now.getUTCMinutes();
  if (start < end) return cur >= start && cur <= end;
  return cur >= start || cur <= end;
}

/**
 * Rejette la commande (400) si au moins un plat est hors de son créneau de
 * disponibilité. Appelé par les DEUX flux de création de commande (v1 + v2) :
 * le masquage côté app n'est qu'un confort d'affichage, le blocage fait foi ici.
 */
export function assertDishesAvailableNow(
  dishes: DishWithWindow[],
  now: Date = new Date(),
): void {
  const unavailable = dishes.filter((d) => !isDishAvailableNow(d, now));
  if (unavailable.length === 0) return;

  const details = unavailable
    .map((d) => `${d.name} (disponible de ${d.available_from} à ${d.available_until})`)
    .join(', ');
  throw new BadRequestException(
    `Article(s) indisponible(s) à cette heure : ${details}. Retirez-le(s) du panier ou commandez pendant le créneau.`,
  );
}

const ORDER_TYPE_LABELS: Record<OrderType, string> = {
  [OrderType.DELIVERY]: 'en livraison',
  [OrderType.PICKUP]: 'à emporter',
  [OrderType.TABLE]: 'sur place',
};

/**
 * Rejette la commande (400) si un plat ou un supplément n'est pas proposé pour
 * le mode de commande choisi. Liste vide ou absente = disponible partout
 * (sécurité : une donnée manquante ne bloque jamais la vente).
 */
export function assertOrderTypeAllowed(
  entities: { name: string; available_order_types?: OrderType[] | null }[],
  type: OrderType | null | undefined,
  kind: 'plat' | 'supplément' = 'plat',
): void {
  if (!type) return;
  const blocked = entities.filter(
    (e) =>
      Array.isArray(e.available_order_types) &&
      e.available_order_types.length > 0 &&
      !e.available_order_types.includes(type),
  );
  if (blocked.length === 0) return;

  const names = blocked.map((e) => e.name).join(', ');
  throw new BadRequestException(
    `${kind === 'plat' ? 'Plat(s)' : 'Supplément(s)'} non disponible(s) ${ORDER_TYPE_LABELS[type]} : ${names}. Changez de mode de commande ou retirez-le(s) du panier.`,
  );
}
