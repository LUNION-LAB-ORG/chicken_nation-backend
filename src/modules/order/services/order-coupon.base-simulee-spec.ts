/**
 * Base en mémoire pour les tests des réductions (codes promo et bons). Les
 * écritures conditionnées (`updateMany`) sont évaluées ET appliquées d'un seul
 * tenant, comme un UPDATE ... WHERE en base : c'est ce qui rend la
 * consommation atomique, et c'est ce que les tests de concurrence éprouvent.
 *
 * Fichier de test seulement (importé par les *.spec.ts). Son nom finit par
 * « -spec.ts » : exclu de la construction (tsconfig.build) sans être lancé
 * comme une suite par jest, comme table-tentatives-simulee-spec.ts.
 */
import { DiscountType, EntityStatus, PromoCodeUsageStatus, TargetType, VoucherStatus } from '@prisma/client';
import { PromoCodeService } from 'src/modules/promo-code/promo-code.service';
import { OrderHelper } from '../helpers/order.helper';
import { OrderCouponService } from './order-coupon.service';

type Ligne = Record<string, any>;

function correspond(ligne: Ligne, where: Ligne = {}): boolean {
  for (const [cle, condition] of Object.entries(where)) {
    if (cle === 'OR') {
      if (!(condition as Ligne[]).some((c) => correspond(ligne, c))) return false;
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

let compteur = 0;
const nouvelId = (prefixe: string) => `${prefixe}-${++compteur}`;

/** Table en mémoire avec les seules opérations Prisma dont les services ont besoin. */
function table(lignes: Ligne[]) {
  return {
    lignes,
    findUnique: jest.fn(async ({ where }: { where: Ligne }) => {
      const l = lignes.find((x) => correspond(x, where));
      return l ? { ...l } : null;
    }),
    findFirst: jest.fn(async ({ where }: { where: Ligne } = { where: {} }) => {
      const l = lignes.find((x) => correspond(x, where));
      return l ? { ...l } : null;
    }),
    findMany: jest.fn(async ({ where }: { where?: Ligne } = {}) =>
      lignes.filter((x) => correspond(x, where)).map((x) => ({ ...x })),
    ),
    count: jest.fn(async ({ where }: { where?: Ligne } = {}) => lignes.filter((x) => correspond(x, where)).length),
    create: jest.fn(async ({ data }: { data: Ligne }) => {
      const l = { id: nouvelId('ligne'), entity_status: EntityStatus.ACTIVE, created_at: new Date(), ...data };
      lignes.push(l);
      return { ...l };
    }),
    update: jest.fn(async ({ where, data }: { where: Ligne; data: Ligne }) => {
      const l = lignes.find((x) => correspond(x, where));
      if (!l) throw new Error('Ligne introuvable');
      appliquer(l, data);
      return { ...l };
    }),
    updateMany: jest.fn(async ({ where, data }: { where: Ligne; data: Ligne }) => {
      // Évaluation et écriture d'un seul tenant : pas d'await entre les deux.
      const cibles = lignes.filter((x) => correspond(x, where));
      cibles.forEach((l) => appliquer(l, data));
      return { count: cibles.length };
    }),
  };
}

export const CLIENT = '44444444-4444-4444-8444-444444444444';
export const AUTRE_CLIENT = '55555555-5555-4555-8555-555555555555';
export const RESTAURANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const RESTAURANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const PLAT = '66666666-6666-4666-8666-666666666666';

const JOUR = 24 * 60 * 60 * 1000;

export function codePromo(surcharge: Ligne = {}): Ligne {
  return {
    id: nouvelId('promo'),
    code: 'BIENVENUE20',
    description: null,
    discount_type: DiscountType.PERCENTAGE,
    discount_value: 20,
    min_order_amount: 0,
    max_discount_amount: null,
    max_usage: null,
    max_usage_per_user: 1,
    usage_count: 0,
    start_date: new Date(Date.now() - JOUR),
    expiration_date: new Date(Date.now() + 30 * JOUR),
    is_active: true,
    restaurant_ids: [],
    target_type: TargetType.ALL_PRODUCTS,
    entity_status: EntityStatus.ACTIVE,
    promo_code_targeted_dishes: [],
    promo_code_targeted_categories: [],
    ...surcharge,
  };
}

export function bon(surcharge: Ligne = {}): Ligne {
  return {
    id: nouvelId('bon'),
    code: 'CN7K2XQ9',
    initial_amount: 10_000,
    remaining_amount: 10_000,
    customer_id: CLIENT,
    status: VoucherStatus.ACTIVE,
    redeemed_at: null,
    expires_at: new Date(Date.now() + 30 * JOUR),
    created_at: new Date(),
    updated_at: new Date(),
    created_by: 'admin',
    entity_status: EntityStatus.ACTIVE,
    ...surcharge,
  };
}

/**
 * Monte un OrderCouponService RÉEL sur une base en mémoire, avec le VRAI
 * moteur des codes promo (PromoCodeService.applyPromoCode) et le VRAI calcul
 * du panier (OrderHelper.calculateOrderDetails).
 */
export function monterCoupons(donnees: {
  promos?: Ligne[];
  bons?: Ligne[];
  usages?: Ligne[];
  redemptions?: Ligne[];
  plats?: Ligne[];
  restaurants?: Ligne[];
  users?: Ligne[];
} = {}) {
  const base = {
    promoCode: table(donnees.promos ?? []),
    voucher: table(donnees.bons ?? []),
    promoCodeUsage: table(donnees.usages ?? []),
    redemption: table(donnees.redemptions ?? []),
    dish: table(donnees.plats ?? []),
    restaurant: table(donnees.restaurants ?? [{ id: RESTAURANT_A, entity_status: EntityStatus.ACTIVE }]),
    user: table(donnees.users ?? []),
    verrous: [] as string[],
  };

  /**
   * Verrous de ligne (`SELECT ... FOR UPDATE`) : pris dans une transaction,
   * rendus à sa fin, comme en PostgreSQL. Une seconde transaction qui demande
   * la même ligne ATTEND. Hors transaction, la requête est seulement notée.
   */
  const verrousPris = new Map<string, Promise<void>>();
  const noterRequete = (morceaux: TemplateStringsArray, valeurs: unknown[]) =>
    base.verrous.push(`${morceaux.join('?')}|${valeurs.join(',')}`);

  const prisma: any = {
    ...base,
    $queryRaw: jest.fn(async (morceaux: TemplateStringsArray, ...valeurs: unknown[]) => {
      noterRequete(morceaux, valeurs);
      return [];
    }),
    $transaction: jest.fn(async (arg: unknown) => {
      if (typeof arg !== 'function') return Promise.all(arg as Promise<unknown>[]);
      const aRendre: (() => void)[] = [];
      const tx = {
        ...prisma,
        $queryRaw: jest.fn(async (morceaux: TemplateStringsArray, ...valeurs: unknown[]) => {
          noterRequete(morceaux, valeurs);
          if (/FOR UPDATE/.test(morceaux.join('?'))) {
            const cle = String(valeurs[0]);
            while (verrousPris.has(cle)) await verrousPris.get(cle);
            let rendre!: () => void;
            verrousPris.set(cle, new Promise<void>((r) => (rendre = r)));
            aRendre.push(() => {
              verrousPris.delete(cle);
              rendre();
            });
          }
          return [];
        }),
      };
      try {
        return await (arg as (t: unknown) => unknown)(tx);
      } finally {
        aRendre.forEach((r) => r());
      }
    }),
  };

  // Les usages lus par deactivateUsageForOrder incluent le code du coupon.
  const findManyUsages = base.promoCodeUsage.findMany;
  base.promoCodeUsage.findMany = jest.fn(async (args: any = {}) => {
    const lignes = await findManyUsages(args);
    if (!args?.include?.promo_code) return lignes;
    return lignes.map((u: Ligne) => ({
      ...u,
      promo_code: { code: base.promoCode.lignes.find((p) => p.id === u.promo_code_id)?.code ?? null },
    }));
  }) as any;

  const appGateway = { emitToBackoffice: jest.fn(), emitToUser: jest.fn() };
  const promoCodeService = new PromoCodeService(prisma, appGateway as any);

  const orderHelper = Object.create(OrderHelper.prototype) as OrderHelper;
  Object.assign(orderHelper, {
    prisma,
    resolveCustomerData: jest.fn(async (dto: { customer_id?: string }) => ({
      customer_id: dto.customer_id,
      loyalty_level: undefined,
      total_points: 0,
      fullname: 'Awa Koné',
      phone: '+2250700000000',
      email: null,
    })),
    getDishesWithDetails: jest.fn(async (ids: string[]) =>
      base.dish.lignes.filter((d) => ids.includes(d.id)),
    ),
  });

  const voucherService = {
    notifierMouvementBon: jest.fn().mockResolvedValue(undefined),
    diffuserBon: jest.fn().mockResolvedValue(undefined),
  };
  const auditService = { record: jest.fn() };

  const service = new OrderCouponService(
    prisma,
    orderHelper,
    promoCodeService,
    voucherService as any,
    auditService as any,
    appGateway as any,
  );
  (service as any).logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  return { service, prisma, base, orderHelper, promoCodeService, voucherService, auditService, appGateway };
}

export function plat(surcharge: Ligne = {}): Ligne {
  return {
    id: PLAT,
    name: 'Burger',
    price: 4000,
    is_promotion: false,
    promotion_price: null,
    composable: false,
    available_order_types: [],
    category_id: 'cat-1',
    entity_status: EntityStatus.ACTIVE,
    ...surcharge,
  };
}

export { PromoCodeUsageStatus, VoucherStatus };
