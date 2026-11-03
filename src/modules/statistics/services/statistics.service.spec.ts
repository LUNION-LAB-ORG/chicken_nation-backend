/**
 * Tableau de bord et Statistiques Commandes comptent les MÊMES ventes
 * (FILTRE_VENTE) : le « Revenu mensuel total » égale le chiffre d'affaires et
 * « Total de commandes » le total des Statistiques. Avant, le tableau de bord
 * oubliait les commandes retirées au comptoir ou servies sur place (COLLECTED).
 * Prisma simulé : chaque requête filtre la liste ci-dessous selon son `where`.
 */
import { OrderStatus } from '@prisma/client';
import { StatisticsService } from './statistics.service';
import { StatisticsOrdersService } from './statistics-orders.service';

const LE = (jour: number) => new Date(2026, 10, jour, 12);
const PERIODE = { startDate: '2026-11-01', endDate: '2026-11-30' };

const commandes = [
  { id: 'livree', status: OrderStatus.COMPLETED, paied: true, net_amount: 10000, created_at: LE(1) },
  { id: 'retiree', status: OrderStatus.COLLECTED, paied: true, net_amount: 7000, created_at: LE(2) },
  { id: 'livree-impayee', status: OrderStatus.COMPLETED, paied: false, net_amount: 5000, created_at: LE(2) },
  { id: 'annulee', status: OrderStatus.CANCELLED, paied: true, net_amount: 3000, created_at: LE(3) },
  { id: 'en-cours', status: OrderStatus.IN_PROGRESS, paied: true, net_amount: 2000, created_at: LE(3) },
];
const plats = [
  { order_id: 'livree', quantity: 2 },
  { order_id: 'retiree', quantity: 1 },
  { order_id: 'livree-impayee', quantity: 4 },
];

function correspond(o: Record<string, unknown>, where: Record<string, any> = {}): boolean {
  return Object.entries(where).every(([cle, cond]) => {
    const v = o[cle];
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('in' in cond && !cond.in.includes(v)) return false;
      if ('gte' in cond && (v as Date) < cond.gte) return false;
      if ('lte' in cond && (v as Date) > cond.lte) return false;
      return true;
    }
    return v === cond;
  });
}

function prismaSimule() {
  const filtrer = (where?: Record<string, any>) => commandes.filter((o) => correspond(o, where));
  const somme = (liste: typeof commandes) => liste.reduce((t, o) => t + o.net_amount, 0);
  return {
    order: {
      count: jest.fn(async ({ where }) => filtrer(where).length),
      aggregate: jest.fn(async ({ where }) => {
        const liste = filtrer(where);
        return {
          _sum: { net_amount: liste.length ? somme(liste) : null },
          _avg: { net_amount: liste.length ? somme(liste) / liste.length : null },
        };
      }),
      groupBy: jest.fn(async () => []),
    },
    orderItem: {
      aggregate: jest.fn(async ({ where }) => {
        const ids = new Set(filtrer(where.order).map((o) => o.id));
        return { _sum: { quantity: plats.filter((p) => ids.has(p.order_id)).reduce((t, p) => t + p.quantity, 0) } };
      }),
      groupBy: jest.fn(async () => []),
    },
    customer: { count: jest.fn(async () => 0) },
    paiement: { groupBy: jest.fn(async () => []) },
  };
}

const enNombre = (valeur: string) => Number(valeur.replace(/\D/g, ''));

describe('Tableau de bord et Statistiques Commandes : mêmes ventes', () => {
  async function lire() {
    const prisma = prismaSimule();
    const tableau = await new StatisticsService(prisma as never).getDashboardStats(PERIODE);
    const statistiques = await new StatisticsOrdersService(prisma as never).getOrdersOverview(PERIODE);
    return { tableau, statistiques };
  }

  it('le revenu du tableau de bord égale le chiffre d’affaires des Statistiques', async () => {
    const { tableau, statistiques } = await lire();
    expect(enNombre(tableau.stats.revenue.value)).toBe(17000);
    expect(statistiques.totalRevenue).toBe(17000);
  });

  it('le total de commandes est le même des deux côtés', async () => {
    const { tableau, statistiques } = await lire();
    expect(Number(tableau.stats.totalOrders.value)).toBe(2);
    expect(statistiques.totalOrders).toBe(2);
  });

  it('les plats vendus comptent aussi la commande retirée, pas la commande impayée', async () => {
    const { tableau } = await lire();
    expect(enNombre(tableau.stats.menusSold.value)).toBe(3);
  });
});
