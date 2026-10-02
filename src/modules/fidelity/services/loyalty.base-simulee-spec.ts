/**
 * Base en mémoire pour les tests des points utilisés sur une commande
 * (retrait au paiement, restitution à l'annulation). Les écritures
 * conditionnées (`updateMany`) sont évaluées ET appliquées d'un seul tenant,
 * comme un UPDATE ... WHERE en base, et une transaction qui lève est annulée
 * en entier : c'est ce que les tests d'idempotence éprouvent.
 *
 * Fichier de test seulement (importé par les *.spec.ts). Son nom finit par
 * « -spec.ts » : exclu de la construction sans être lancé comme une suite,
 * comme order-coupon.base-simulee-spec.ts.
 */
import {
  LoyaltyLevel,
  LoyaltyPointIsUsed,
  LoyaltyPointType,
  OrderStatus,
} from '@prisma/client';
import { LoyaltyService } from './loyalty.service';

type Ligne = Record<string, any>;

export const CLIENT = '44444444-4444-4444-8444-444444444444';
export const COMMANDE = '11111111-1111-4111-8111-111111111111';

export const REGLAGES = {
  id: 'config-1',
  is_active: true,
  points_per_xof: 0.002,
  points_expiration_days: 365,
  minimum_redemption_points: 100,
  point_value_in_xof: 20,
  max_redemption_pct: 50,
  bonus_standard: 0,
  bonus_vip: 150,
  bonus_vvip: 200,
  standard_threshold: 0,
  premium_threshold: 700,
  gold_threshold: 1000,
};

interface Tables {
  customer: Ligne[];
  order: Ligne[];
  loyaltyPoint: Ligne[];
}

function correspond(ligne: Ligne, where: Ligne = {}, tables?: Tables): boolean {
  for (const [cle, condition] of Object.entries(where)) {
    if (condition === undefined) continue;
    if (cle === 'OR') {
      if (!(condition as Ligne[]).some((c) => correspond(ligne, c, tables))) return false;
      continue;
    }
    // Relations lues par le code testé.
    if (cle === 'order' && tables) {
      const commande = tables.order.find((o) => o.id === ligne.order_id);
      if (!commande || !correspond(commande, condition, tables)) return false;
      continue;
    }
    if (cle === 'loyalty_points' && tables) {
      const lignes = tables.loyaltyPoint.filter((l) => l.order_id === ligne.id);
      if ('none' in condition && lignes.some((l) => correspond(l, condition.none, tables))) return false;
      continue;
    }
    if (cle === 'delivery') {
      if (!correspond(ligne.delivery ?? {}, condition, tables) || !ligne.delivery) return false;
      continue;
    }
    const valeur = ligne[cle];
    if (condition === null) {
      if (valeur !== null && valeur !== undefined) return false;
    } else if (typeof condition === 'object' && !(condition instanceof Date)) {
      const c = condition as Ligne;
      if ('not' in c && valeur === c.not) return false;
      if ('gte' in c && !(valeur >= c.gte)) return false;
      if ('gt' in c && !(valeur > c.gt)) return false;
      if ('lt' in c && !(valeur < c.lt)) return false;
      if ('lte' in c && !(valeur <= c.lte)) return false;
      if ('in' in c && !c.in.includes(valeur)) return false;
    } else if (valeur !== condition) {
      return false;
    }
  }
  return true;
}

function appliquer(ligne: Ligne, data: Ligne): void {
  for (const [cle, valeur] of Object.entries(data)) {
    if (valeur && typeof valeur === 'object' && !(valeur instanceof Date)) {
      if ('increment' in valeur) ligne[cle] += valeur.increment;
      else if ('decrement' in valeur) ligne[cle] -= valeur.decrement;
    } else {
      ligne[cle] = valeur;
    }
  }
}

const choisir = (ligne: Ligne, select?: Ligne) =>
  select ? Object.fromEntries(Object.keys(select).map((cle) => [cle, ligne[cle]])) : { ...ligne };

let compteur = 0;
const nouvelId = (prefixe: string) => `${prefixe}-${++compteur}`;

/** Une ligne de points gagnés, dépensable. */
export function gain(points: number, surcharge: Ligne = {}): Ligne {
  return {
    id: nouvelId('gain'),
    customer_id: CLIENT,
    points,
    points_used: 0,
    is_used: LoyaltyPointIsUsed.NO,
    type: LoyaltyPointType.EARNED,
    reason: 'gain',
    order_id: null,
    expires_at: null,
    created_at: new Date('2026-09-01T10:00:00Z'),
    updated_at: new Date('2026-09-01T10:00:00Z'),
    ...surcharge,
  };
}

export function commande(surcharge: Ligne = {}): Ligne {
  return {
    id: COMMANDE,
    reference: 'ORD-261002-1',
    customer_id: CLIENT,
    status: OrderStatus.ACCEPTED,
    paied: true,
    points: 150,
    entity_status: 'ACTIVE',
    cancelled_at: null,
    created_at: new Date('2026-10-02T09:00:00Z'),
    ...surcharge,
  };
}

export function monterFidelite({
  solde,
  lignes = [gain(solde)],
  commandes = [commande()],
}: {
  solde: number;
  lignes?: Ligne[];
  commandes?: Ligne[];
}) {
  const tables: Tables = {
    customer: [
      {
        id: CLIENT,
        total_points: solde,
        lifetime_points: solde,
        status_points: 0,
        loyalty_level: LoyaltyLevel.STANDARD,
      },
    ],
    order: commandes,
    loyaltyPoint: lignes,
  };

  const client = {
    loyaltyConfig: {
      findFirst: jest.fn(async () => ({ ...REGLAGES })),
    },
    customer: {
      findUnique: jest.fn(async ({ where, select }: Ligne) => {
        const ligne = tables.customer.find((c) => c.id === where.id);
        return ligne ? choisir(ligne, select) : null;
      }),
      update: jest.fn(async ({ where, data }: Ligne) => {
        const ligne = tables.customer.find((c) => c.id === where.id);
        if (!ligne) throw new Error('client introuvable');
        appliquer(ligne, data);
        return { ...ligne };
      }),
      updateMany: jest.fn(async ({ where, data }: Ligne) => {
        const lignes = tables.customer.filter((c) => correspond(c, where, tables));
        lignes.forEach((l) => appliquer(l, data));
        return { count: lignes.length };
      }),
    },
    order: {
      findUnique: jest.fn(async ({ where, select }: Ligne) => {
        const ligne = tables.order.find((o) => o.id === where.id);
        return ligne ? choisir(ligne, select) : null;
      }),
      aggregate: jest.fn(async ({ where }: Ligne) => {
        const lignes = tables.order.filter((o) => correspond(o, where, tables));
        const somme = lignes.reduce((s, o) => s + (o.points ?? 0), 0);
        return { _sum: { points: lignes.length ? somme : null } };
      }),
    },
    loyaltyPoint: {
      findFirst: jest.fn(async ({ where, include }: Ligne) => {
        const ligne = tables.loyaltyPoint.find((l) => correspond(l, where, tables));
        if (!ligne) return null;
        const copie: Ligne = { ...ligne };
        if (include?.order) {
          const o = tables.order.find((x) => x.id === ligne.order_id);
          copie.order = o ? choisir(o, include.order.select) : null;
        }
        return copie;
      }),
      findMany: jest.fn(async ({ where, select, take }: Ligne) => {
        const lignes = tables.loyaltyPoint
          .filter((l) => correspond(l, where, tables))
          .sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
          .slice(0, take ?? undefined);
        return lignes.map((l) => choisir(l, select));
      }),
      update: jest.fn(async ({ where, data }: Ligne) => {
        const ligne = tables.loyaltyPoint.find((l) => l.id === where.id);
        if (!ligne) throw new Error('ligne introuvable');
        appliquer(ligne, data);
        return { ...ligne };
      }),
      updateMany: jest.fn(async ({ where, data }: Ligne) => {
        const lignes = tables.loyaltyPoint.filter((l) => correspond(l, where, tables));
        lignes.forEach((l) => appliquer(l, data));
        return { count: lignes.length };
      }),
      create: jest.fn(async ({ data }: Ligne) => {
        const ligne = {
          id: nouvelId('point'),
          points_used: 0,
          is_used: LoyaltyPointIsUsed.NO,
          expires_at: null,
          order_id: null,
          created_at: new Date(),
          updated_at: new Date(),
          ...data,
        };
        tables.loyaltyPoint.push(ligne);
        return { ...ligne };
      }),
    },
    loyaltyLevelHistory: { create: jest.fn() },
  };

  // Transaction : tout ou rien. Une exception remet les tables dans l'état
  // d'avant, comme un ROLLBACK.
  const prisma = {
    ...client,
    $transaction: jest.fn(async (fn: (tx: typeof client) => Promise<unknown>) => {
      const avant = structuredClone(tables);
      try {
        return await fn(client);
      } catch (e) {
        tables.customer.splice(0, tables.customer.length, ...avant.customer);
        tables.order.splice(0, tables.order.length, ...avant.order);
        tables.loyaltyPoint.splice(0, tables.loyaltyPoint.length, ...avant.loyaltyPoint);
        throw e;
      }
    }),
  };

  const loyaltyEvent = {
    redeemPointsEvent: jest.fn(),
    addPointsEvent: jest.fn(),
    levelUpEvent: jest.fn(),
  };
  const appGateway = { emitToUser: jest.fn(), emitToBackoffice: jest.fn() };
  const service = new LoyaltyService(prisma as never, loyaltyEvent as never, appGateway as never);

  return {
    service,
    prisma,
    tables,
    appGateway,
    loyaltyEvent,
    solde: () => tables.customer[0].total_points,
    lignesDe: (type: LoyaltyPointType) => tables.loyaltyPoint.filter((l) => l.type === type),
  };
}
