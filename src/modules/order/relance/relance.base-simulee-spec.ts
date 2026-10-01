/**
 * Base en mémoire pour les tests de la relance (service et tâche d'alerte).
 *
 * Les `where` reçus sont ÉVALUÉS (AND, OR, NOT, null, not, in, comparaisons,
 * endsWith, filtres de relation) : retirer une condition d'une écriture
 * conditionnée fait donc casser le test de la règle qu'elle porte. Chaque
 * `updateMany` est évalué et appliqué d'un seul tenant, comme un UPDATE ...
 * WHERE en base.
 *
 * Les transactions interactives passent une à une (comme deux transactions
 * qui se disputent les mêmes lignes) et sont ANNULÉES si leur fonction lève :
 * ce qu'elles ont écrit disparaît.
 *
 * Fichier de test seulement. Son nom finit par « -spec.ts » : exclu de la
 * construction sans être lancé comme une suite par jest.
 */
import { EntityStatus, OrderStatus, PaymentMethod, User, UserRole, UserType } from '@prisma/client';
import { BROUILLON_WHERE } from '../helpers/brouillons.rules';
import { OrderRelanceService } from '../services/order-relance.service';

type Ligne = Record<string, any>;

const egal = (a: unknown, b: unknown) =>
  a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b;

const OPERATEURS = ['not', 'in', 'gte', 'gt', 'lt', 'lte', 'endsWith', 'equals'];

/** Le sous-ensemble des filtres Prisma employé par la relance, évalué en mémoire. */
export function correspond(ligne: Ligne | null | undefined, where: Ligne | undefined): boolean {
  if (!where) return true;
  if (!ligne) return false;
  for (const [cle, condition] of Object.entries(where)) {
    if (condition === undefined) continue;
    if (cle === 'AND') {
      const liste = Array.isArray(condition) ? condition : [condition];
      if (!liste.every((c) => correspond(ligne, c))) return false;
      continue;
    }
    if (cle === 'OR') {
      if (!(condition as Ligne[]).some((c) => correspond(ligne, c))) return false;
      continue;
    }
    if (cle === 'NOT') {
      const liste = Array.isArray(condition) ? condition : [condition];
      if (liste.some((c) => correspond(ligne, c))) return false;
      continue;
    }
    const valeur = ligne[cle];
    if (condition === null) {
      if (valeur !== null && valeur !== undefined) return false;
      continue;
    }
    if (condition instanceof Date || typeof condition !== 'object') {
      if (!egal(valeur, condition)) return false;
      continue;
    }
    const c = condition as Ligne;
    if (Object.keys(c).some((k) => OPERATEURS.includes(k))) {
      if ('equals' in c && !egal(valeur, c.equals)) return false;
      if ('not' in c) {
        if (c.not === null ? valeur === null || valeur === undefined : egal(valeur, c.not)) return false;
      }
      if ('in' in c && !(c.in as unknown[]).some((v) => egal(v, valeur))) return false;
      if ('gte' in c && !(valeur != null && valeur >= c.gte)) return false;
      if ('gt' in c && !(valeur != null && valeur > c.gt)) return false;
      if ('lt' in c && !(valeur != null && valeur < c.lt)) return false;
      if ('lte' in c && !(valeur != null && valeur <= c.lte)) return false;
      if ('endsWith' in c && !(typeof valeur === 'string' && valeur.endsWith(c.endsWith))) return false;
      continue;
    }
    // Filtre de relation (`customer: { phone: ... }`, `order: { restaurant_id }`).
    if (!correspond(valeur, c)) return false;
  }
  return true;
}

export const RESTO_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const RESTO_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

export const agent = (id: string, fullname: string, surcharge: Partial<User> = {}): User =>
  ({
    id,
    fullname,
    role: UserRole.CALL_CENTER,
    type: UserType.BACKOFFICE,
    restaurant_id: null,
    ...surcharge,
  }) as User;

export const AWA = agent('11111111-0000-4000-8000-000000000001', 'Agent Awa');
export const YAO = agent('11111111-0000-4000-8000-000000000002', 'Agent Yao');
export const ADMIN = agent('11111111-0000-4000-8000-000000000003', 'Admin', { role: UserRole.ADMIN });

let numero = 0;

/** Panier de l'application non payé, `minutes` avant `maintenant`. */
export function commande(maintenant: Date, minutes: number, surcharge: Ligne = {}): Ligne {
  numero += 1;
  return {
    id: `0000000${numero}`.slice(-8) + '-0000-4000-8000-000000000000',
    reference: `ORD-261001-${numero}`,
    created_at: new Date(maintenant.getTime() - minutes * 60_000),
    customer_id: `client-${numero}`,
    restaurant_id: RESTO_A,
    fullname: `Client ${numero}`,
    phone: `07000000${String(numero).padStart(2, '0')}`,
    type: 'DELIVERY',
    amount: 5050,
    auto: true,
    status: OrderStatus.PENDING,
    paied: false,
    payment_method: PaymentMethod.ONLINE,
    entity_status: EntityStatus.ACTIVE,
    customer: { phone: null, first_name: null, last_name: null },
    restaurant: { id: surcharge.restaurant_id ?? RESTO_A, name: 'Riviera' },
    paiements: [],
    ...surcharge,
  };
}

/** Monte un OrderRelanceService RÉEL sur une base en mémoire. */
export function monterRelance(donnees: { commandes?: Ligne[]; relances?: Ligne[]; users?: User[] } = {}) {
  const commandes = donnees.commandes ?? [];
  const relances: Ligne[] = donnees.relances ?? [];
  const journal: Ligne[] = [];
  const users: User[] = donnees.users ?? [AWA, YAO, ADMIN];
  const settings: Record<string, string> = {};
  let ids = 0;

  const utilisateur = (id: string | null | undefined) => {
    const u = users.find((x) => x.id === id);
    return u ? { id: u.id, fullname: u.fullname } : null;
  };
  const relanceDe = (orderId: string) => relances.find((r) => r.order_id === orderId) ?? null;
  const vueRelance = (r: Ligne | null) =>
    r ? { ...r, pris_par: utilisateur(r.pris_par_id), ignore_par: utilisateur(r.ignore_par_id) } : null;
  const vueCommande = (c: Ligne): Ligne => ({ ...c, relance: vueRelance(relanceDe(c.id)) });

  const prisma: any = {
    order: {
      findUnique: jest.fn(async ({ where }: { where: Ligne }) => {
        const c = commandes.find((x) => x.id === where.id);
        return c ? vueCommande(c) : null;
      }),
      findMany: jest.fn(async ({ where }: { where: Ligne }) =>
        commandes.filter((c) => correspond(vueCommande(c), where)).map(vueCommande)
          .sort((a, b) => b.created_at.getTime() - a.created_at.getTime()),
      ),
    },
    orderRelance: {
      lignes: relances,
      findUnique: jest.fn(async ({ where }: { where: Ligne }) => vueRelance(relanceDe(where.order_id))),
      findMany: jest.fn(async ({ where }: { where: Ligne }) =>
        relances
          .map((r) => ({ ...vueRelance(r), order: vueCommande(commandes.find((c) => c.id === r.order_id)!) }))
          .filter((r) => correspond(r, where)),
      ),
      count: jest.fn(async ({ where }: { where: Ligne }) =>
        relances
          .map((r) => ({ ...r, order: commandes.find((c) => c.id === r.order_id) }))
          .filter((r) => correspond(r, where)).length,
      ),
      createMany: jest.fn(async ({ data }: { data: Ligne[] }) => {
        let count = 0;
        for (const d of data) {
          if (relanceDe(d.order_id)) continue;
          relances.push({
            id: `relance-${++ids}`,
            alerte_le: null,
            pris_par_id: null,
            pris_le: null,
            prise_expire_le: null,
            ignore_par_id: null,
            ignore_le: null,
            raison_code: null,
            raison_texte: null,
            ...d,
          });
          count += 1;
        }
        return { count };
      }),
      updateMany: jest.fn(async ({ where, data }: { where: Ligne; data: Ligne }) => {
        // Évaluation et écriture d'un seul tenant : pas d'await entre les deux.
        const cibles = relances.filter((r) => correspond(r, where));
        cibles.forEach((r) => Object.assign(r, data));
        return { count: cibles.length };
      }),
    },
    orderRelanceJournal: {
      lignes: journal,
      create: jest.fn(async ({ data }: { data: Ligne }) => {
        const l = { id: `journal-${++ids}`, created_at: new Date(), ...data };
        journal.push(l);
        return l;
      }),
      createMany: jest.fn(async ({ data }: { data: Ligne[] }) => {
        for (const d of data) journal.push({ id: `journal-${++ids}`, created_at: new Date(), ...d });
        return { count: data.length };
      }),
      findFirst: jest.fn(async ({ where }: { where: Ligne }) => {
        const l = [...journal].reverse().find((x) => correspond(x, where));
        return l ? { ...l, user: utilisateur(l.user_id) } : null;
      }),
    },
    crmContact: { findMany: jest.fn(async () => []) },
  };

  /** Transactions une à une, annulées si leur fonction lève. */
  let file: Promise<unknown> = Promise.resolve();
  prisma.$transaction = jest.fn(async (arg: unknown) => {
    if (Array.isArray(arg)) return Promise.all(arg);
    const tour = file.then(async () => {
      const relancesAvant = relances.map((r) => ({ ...r }));
      const journalAvant = journal.length;
      try {
        return await (arg as (tx: unknown) => Promise<unknown>)(prisma);
      } catch (e) {
        relances.splice(0, relances.length, ...relancesAvant);
        journal.splice(journalAvant);
        throw e;
      }
    });
    file = tour.catch(() => undefined);
    return tour;
  });

  const settingsService = { getMany: jest.fn(async (cles: string[]) => {
    const r: Record<string, string> = {};
    for (const k of cles) if (settings[k] !== undefined) r[k] = settings[k];
    return r;
  }) };
  const appGateway = { emitToRelances: jest.fn() };
  const service = new OrderRelanceService(prisma, settingsService as never, appGateway as never);

  // Vérifie que la lecture des brouillons passe bien par la règle unique.
  const lecturesBrouillons = () =>
    prisma.order.findMany.mock.calls.filter((c: [Ligne]) => c[0].where?.AND?.[0] === BROUILLON_WHERE).length;

  return { service, prisma, commandes, relances, journal, settings, appGateway, lecturesBrouillons };
}
