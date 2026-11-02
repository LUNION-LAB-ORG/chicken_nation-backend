/**
 * Base simulée en mémoire pour les tests des retours privés : les seules
 * requêtes Prisma que le dépôt, le traitement et la tâche de retard emploient,
 * avec les filtres dont ils se servent (égalité, null, not, in, lt, gte, OR).
 *
 * Chaque requête rend la main une fois avant de s'exécuter d'un bloc, comme un
 * aller et retour vers la base : deux appels lancés ensemble s'entrelacent
 * entre deux requêtes, jamais au milieu d'une. Un `updateMany` conditionné est
 * donc un vrai claim : le second ne trouve plus la ligne dans l'état lu.
 *
 * Nom en « -spec.ts » : exclu de la construction sans être pris pour une suite
 * par Jest (voir redis-envois-simule-spec.ts).
 */
import { Prisma } from '@prisma/client';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Ligne = Record<string, any>;

const allerRetour = () => Promise.resolve();

export function correspond(ligne: Ligne, where: Ligne | undefined): boolean {
  for (const [cle, attendu] of Object.entries(where ?? {})) {
    if (attendu === undefined) continue;
    if (cle === 'OR') {
      if (!(attendu as Ligne[]).some((w) => correspond(ligne, w))) return false;
      continue;
    }
    if (cle === 'data' && attendu && typeof attendu === 'object' && 'path' in attendu) {
      const valeur = (attendu.path as string[]).reduce((v: any, k) => (v == null ? v : v[k]), ligne.data);
      if (valeur !== attendu.equals) return false;
      continue;
    }
    const valeur = ligne[cle];
    if (attendu === null) {
      if (valeur !== null && valeur !== undefined) return false;
      continue;
    }
    if (attendu instanceof Date) {
      if (!(valeur instanceof Date) || valeur.getTime() !== attendu.getTime()) return false;
      continue;
    }
    if (typeof attendu === 'object') {
      if ('not' in attendu && valeur === attendu.not) return false;
      if ('in' in attendu && !(attendu.in as unknown[]).includes(valeur)) return false;
      if ('lt' in attendu && !(valeur instanceof Date && valeur.getTime() < attendu.lt.getTime())) return false;
      if ('gte' in attendu && !(valeur instanceof Date && valeur.getTime() >= attendu.gte.getTime())) return false;
      continue;
    }
    if (valeur !== attendu) return false;
  }
  return true;
}

function appliquer(ligne: Ligne, data: Ligne): void {
  for (const [cle, valeur] of Object.entries(data)) {
    if (valeur === undefined) continue;
    if (valeur === Prisma.DbNull || valeur === Prisma.JsonNull) ligne[cle] = null;
    else if (valeur && typeof valeur === 'object' && 'increment' in valeur) ligne[cle] = (ligne[cle] ?? 0) + valeur.increment;
    else ligne[cle] = valeur;
  }
}

function trier(lignes: Ligne[], orderBy: Ligne | Ligne[] | undefined): Ligne[] {
  const ordres = orderBy ? (Array.isArray(orderBy) ? orderBy : [orderBy]) : [];
  return [...lignes].sort((a, b) => {
    for (const ordre of ordres) {
      const [cle, sens] = Object.entries(ordre)[0] as [string, 'asc' | 'desc'];
      const va = a[cle] instanceof Date ? a[cle].getTime() : a[cle];
      const vb = b[cle] instanceof Date ? b[cle].getTime() : b[cle];
      if (va === vb) continue;
      return (va < vb ? -1 : 1) * (sens === 'desc' ? -1 : 1);
    }
    return 0;
  });
}

/** Une table : create, findFirst, findMany, count, updateMany. */
function table(lignes: Ligne[], prefixe: string, defauts: () => Ligne = () => ({})) {
  let n = 0;
  return {
    lignes,
    create: jest.fn(async ({ data }: { data: Ligne }) => {
      await allerRetour();
      const ligne: Ligne = { id: `${prefixe}-${++n}`, ...defauts(), created_at: new Date(), ...data };
      for (const [cle, valeur] of Object.entries(ligne)) {
        if (valeur === Prisma.DbNull || valeur === Prisma.JsonNull) ligne[cle] = null;
      }
      lignes.push(ligne);
      return { ...ligne };
    }),
    findFirst: jest.fn(async ({ where, orderBy }: { where?: Ligne; orderBy?: Ligne } = {}) => {
      await allerRetour();
      const trouvee = trier(lignes.filter((l) => correspond(l, where)), orderBy)[0];
      return trouvee ? { ...trouvee } : null;
    }),
    findMany: jest.fn(async ({ where, orderBy, take }: { where?: Ligne; orderBy?: Ligne; take?: number } = {}) => {
      await allerRetour();
      const trouvees = trier(lignes.filter((l) => correspond(l, where)), orderBy).map((l) => ({ ...l }));
      return take ? trouvees.slice(0, take) : trouvees;
    }),
    count: jest.fn(async ({ where }: { where?: Ligne } = {}) => {
      await allerRetour();
      return lignes.filter((l) => correspond(l, where)).length;
    }),
    updateMany: jest.fn(async ({ where, data }: { where?: Ligne; data: Ligne }) => {
      await allerRetour();
      let count = 0;
      for (const ligne of lignes) {
        if (correspond(ligne, where)) {
          appliquer(ligne, data);
          count++;
        }
      }
      return { count };
    }),
  };
}

export function avisParDefaut(): Ligne {
  return {
    restaurant_id: null,
    telephone: null,
    prenom: null,
    accord_rappel: false,
    source: 'site',
    customer_id: null,
    rapproche_at: null,
    order_id: null,
    ticket_id: null,
    ticket_demande_at: null,
    statut: 'NOUVEAU',
    echeance_at: null,
    premier_contact_at: null,
    alerte_retard_at: null,
    tentatives_appel: 0,
    solution: null,
    resolu_at: null,
    clos_at: null,
    agent_id: null,
    entity_status: 'ACTIVE',
    supprime_at: null,
    supprime_par_id: null,
  };
}

export function creerBaseAvis(depart: {
  avis?: Ligne[];
  restaurants?: Ligne[];
  customers?: Ligne[];
  orders?: Ligne[];
  users?: Ligne[];
  categories?: Ligne[];
  notifications?: Ligne[];
} = {}) {
  const avisPrive = table((depart.avis ?? []).map((a) => ({ ...avisParDefaut(), ...a })), 'avis', avisParDefaut);
  const avisPriveSuivi = table([], 'suivi', () => ({
    resultat: null,
    note: null,
    statut_avant: null,
    statut_apres: null,
    solution: null,
    auteur_id: null,
    auteur_nom: null,
    meta: null,
  }));
  const restaurant = table(depart.restaurants ?? [], 'resto');
  const customer = table(depart.customers ?? [], 'client');
  const order = table(depart.orders ?? [], 'commande');
  const user = table(depart.users ?? [], 'user');

  // `include` de l'avis : les relations lues dans les autres tables, sauf si
  // le test les a posées sur la ligne.
  const joindre = (a: Ligne | null): Ligne | null => {
    if (!a) return a;
    const trouver = (t: { lignes: Ligne[] }, id: unknown) => (id ? (t.lignes.find((l) => l.id === id) ?? null) : null);
    return {
      ...a,
      restaurant: a.restaurant ?? trouver(restaurant, a.restaurant_id),
      customer: a.customer ?? trouver(customer, a.customer_id),
      agent: a.agent ?? trouver(user, a.agent_id),
      order: a.order ?? trouver(order, a.order_id),
      ticket: a.ticket ?? null,
    };
  };
  const findFirstBrut = avisPrive.findFirst.getMockImplementation()!;
  const findManyBrut = avisPrive.findMany.getMockImplementation()!;
  avisPrive.findFirst.mockImplementation(async (args) => joindre(await findFirstBrut(args)) as never);
  avisPrive.findMany.mockImplementation(async (args) => (await findManyBrut(args)).map((l) => joindre(l) as Ligne) as never);

  const prisma = {
    avisPrive,
    avisPriveSuivi,
    restaurant,
    customer,
    order,
    user,
    ticketCategory: table(depart.categories ?? [], 'categorie'),
    ticketMessage: table([], 'message'),
    notification: table(depart.notifications ?? [], 'notif'),
    crmContact: table([], 'crm'),
    $transaction: jest.fn(async (travail: (tx: unknown) => Promise<unknown>) => travail(prisma)),
  };
  return {
    prisma,
    /** Ligne d'avis telle qu'en base (référence vivante). */
    avis: (id: string) => avisPrive.lignes.find((l) => l.id === id) as Ligne,
    suivis: (id: string) => avisPriveSuivi.lignes.filter((l) => l.avis_id === id),
  };
}
