/**
 * Base simulée en mémoire pour les tests des incidents : les seules requêtes
 * Prisma que les services emploient, avec leurs filtres (égalité, null, not,
 * in, lt, gte, startsWith, contains, OR, relation).
 *
 * Chaque requête rend la main une fois avant de s'exécuter d'un bloc, comme
 * un aller et retour vers la base : deux appels lancés ensemble
 * s'entrelacent entre deux requêtes, jamais au milieu d'une. Un `updateMany`
 * conditionné est donc une vraie revendication : le second ne trouve plus la
 * ligne dans l'état lu.
 *
 * Nom en « -spec.ts » : exclu de la construction sans être pris pour une
 * suite par Jest (voir avis-prive-base-simulee-spec.ts).
 */
import { Prisma } from '@prisma/client';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Ligne = Record<string, any>;

const allerRetour = () => Promise.resolve();

const OPERATEURS = ['not', 'in', 'lt', 'lte', 'gt', 'gte', 'startsWith', 'contains', 'equals'];
const temps = (v: unknown) => (v instanceof Date ? v.getTime() : (v as number));

export function correspond(ligne: Ligne, where: Ligne | undefined): boolean {
  for (const [cle, attendu] of Object.entries(where ?? {})) {
    if (attendu === undefined) continue;
    if (cle === 'OR') {
      if (!(attendu as Ligne[]).some((w) => correspond(ligne, w))) return false;
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
      const operateur = Object.keys(attendu).some((k) => OPERATEURS.includes(k));
      if (!operateur) {
        // Filtre sur une relation : la ligne jointe doit correspondre.
        if (!valeur || typeof valeur !== 'object' || !correspond(valeur, attendu)) return false;
        continue;
      }
      const insensible = attendu.mode === 'insensitive';
      const texte = (v: unknown) => (insensible ? String(v ?? '').toLowerCase() : String(v ?? ''));
      if ('not' in attendu) {
        if (attendu.not === null ? valeur === null || valeur === undefined : valeur === attendu.not) return false;
      }
      if ('equals' in attendu && texte(valeur) !== texte(attendu.equals)) return false;
      if ('in' in attendu && !(attendu.in as unknown[]).includes(valeur)) return false;
      if ('lt' in attendu && !(valeur != null && temps(valeur) < temps(attendu.lt))) return false;
      if ('lte' in attendu && !(valeur != null && temps(valeur) <= temps(attendu.lte))) return false;
      if ('gt' in attendu && !(valeur != null && temps(valeur) > temps(attendu.gt))) return false;
      if ('gte' in attendu && !(valeur != null && temps(valeur) >= temps(attendu.gte))) return false;
      if ('startsWith' in attendu && !texte(valeur).startsWith(texte(attendu.startsWith))) return false;
      if ('contains' in attendu && !(valeur != null && texte(valeur).includes(texte(attendu.contains)))) return false;
      continue;
    }
    if (valeur !== attendu) return false;
  }
  return true;
}

function appliquer(ligne: Ligne, data: Ligne): void {
  for (const [cle, valeur] of Object.entries(data)) {
    if (valeur === undefined) continue;
    ligne[cle] = valeur === Prisma.DbNull || valeur === Prisma.JsonNull ? null : valeur;
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
      if (va == null) return 1;
      if (vb == null) return -1;
      return (va < vb ? -1 : 1) * (sens === 'desc' ? -1 : 1);
    }
    return 0;
  });
}

type Jointure = (l: Ligne) => Ligne;

/** Une table : create, findFirst, findUnique, findMany, count, update, updateMany. */
function table(lignes: Ligne[], prefixe: string, defauts: () => Ligne = () => ({}), joindre: Jointure = (l) => ({ ...l })) {
  let n = lignes.length;
  const trouver = (where?: Ligne, orderBy?: Ligne | Ligne[]) =>
    trier(lignes.map(joindre).filter((l) => correspond(l, where)), orderBy);
  return {
    lignes,
    create: jest.fn(async ({ data }: { data: Ligne }) => {
      await allerRetour();
      const ligne: Ligne = { id: `${prefixe}-${++n}`, ...defauts(), created_at: new Date(), ...data };
      for (const [cle, valeur] of Object.entries(ligne)) {
        if (valeur === Prisma.DbNull || valeur === Prisma.JsonNull) ligne[cle] = null;
      }
      lignes.push(ligne);
      return joindre(ligne);
    }),
    findFirst: jest.fn(async ({ where, orderBy }: { where?: Ligne; orderBy?: Ligne | Ligne[] } = {}) => {
      await allerRetour();
      return trouver(where, orderBy)[0] ?? null;
    }),
    findUnique: jest.fn(async ({ where }: { where?: Ligne } = {}) => {
      await allerRetour();
      return trouver(where)[0] ?? null;
    }),
    findMany: jest.fn(
      async ({ where, orderBy, take, skip }: { where?: Ligne; orderBy?: Ligne | Ligne[]; take?: number; skip?: number } = {}) => {
        await allerRetour();
        const trouvees = trouver(where, orderBy).slice(skip ?? 0);
        return take ? trouvees.slice(0, take) : trouvees;
      },
    ),
    count: jest.fn(async ({ where }: { where?: Ligne } = {}) => {
      await allerRetour();
      return trouver(where).length;
    }),
    update: jest.fn(async ({ where, data }: { where: Ligne; data: Ligne }) => {
      await allerRetour();
      const ligne = lignes.find((l) => correspond(joindre(l), where));
      if (!ligne) throw new Error('ligne introuvable');
      appliquer(ligne, data);
      return joindre(ligne);
    }),
    updateMany: jest.fn(async ({ where, data }: { where?: Ligne; data: Ligne }) => {
      await allerRetour();
      let count = 0;
      for (const ligne of lignes) {
        if (correspond(joindre(ligne), where)) {
          appliquer(ligne, data);
          count++;
        }
      }
      return { count };
    }),
  };
}

export function incidentParDefaut(): Ligne {
  return {
    statut: 'OUVERT',
    ticket_id: null,
    avis_id: null,
    comment_id: null,
    agent_id: null,
    assigne_at: null,
    alerte_retard_at: null,
    cause: null,
    action: null,
    geste: null,
    bon_montant: null,
    voucher_id: null,
    bon_demande_at: null,
    bon_message_at: null,
    bon_message_canal: null,
    resolu_at: null,
    resolu_par_id: null,
    resolu_par_nom: null,
    recontact: null,
    reaction: null,
    cloture_at: null,
    cloture_par_id: null,
    cloture_par_nom: null,
    signale_par_id: null,
    signale_par_nom: null,
  };
}

export function creerBaseIncidents(depart: {
  incidents?: Ligne[];
  categories?: Ligne[];
  orders?: Ligne[];
  restaurants?: Ligne[];
  customers?: Ligne[];
  users?: Ligne[];
  vouchers?: Ligne[];
  tickets?: Ligne[];
  comments?: Ligne[];
  avis?: Ligne[];
  settings?: Ligne[];
} = {}) {
  const restaurants = depart.restaurants ?? [];
  const customers = depart.customers ?? [];
  const users = depart.users ?? [];
  const vouchers = depart.vouchers ?? [];
  const tickets = depart.tickets ?? [];
  const comments = depart.comments ?? [];
  const categories = depart.categories ?? [];
  const orders = depart.orders ?? [];
  const suivis: Ligne[] = [];
  const par = (lignes: Ligne[], id: unknown) => (id ? (lignes.find((l) => l.id === id) ?? null) : null);

  const joindreCommande: Jointure = (o) => ({
    ...o,
    restaurant: par(restaurants, o.restaurant_id),
    customer: par(customers, o.customer_id),
  });
  // `include` de l'incident : les relations lues dans les autres tables.
  const joindreIncident: Jointure = (i) => ({
    ...i,
    categorie: par(categories, i.categorie_id),
    order: par(orders, i.order_id),
    restaurant: par(restaurants, i.restaurant_id),
    customer: par(customers, i.customer_id),
    agent: par(users, i.agent_id),
    voucher: par(vouchers, i.voucher_id),
    ticket: par(tickets, i.ticket_id),
    comment: par(comments, i.comment_id),
    suivis: suivis.filter((s) => s.incident_id === i.id).sort((a, b) => a.created_at.getTime() - b.created_at.getTime()),
  });

  const incident = table(
    (depart.incidents ?? []).map((i) => ({ ...incidentParDefaut(), ...i })),
    'incident',
    incidentParDefaut,
    joindreIncident,
  );
  const prisma = {
    incident,
    incidentSuivi: table(suivis, 'suivi', () => ({ note: null, statut_avant: null, statut_apres: null, auteur_id: null, auteur_nom: null, meta: null })),
    incidentCategorie: table(categories, 'categorie', () => ({ actif: true, ordre: 0, delai_heures: 24 })),
    order: table(orders, 'commande', () => ({}), joindreCommande),
    restaurant: table(restaurants, 'resto'),
    customer: table(customers, 'client'),
    user: table(users, 'user'),
    voucher: table(vouchers, 'bon'),
    ticketThread: table(tickets, 'ticket'),
    comment: table(comments, 'note'),
    avisPrive: table(depart.avis ?? [], 'avis'),
    avisPriveSuivi: table([], 'avis-suivi'),
    setting: table(depart.settings ?? [], 'reglage'),
    $transaction: jest.fn(async (travail: (tx: unknown) => Promise<unknown>) => travail(prisma)),
  };

  return {
    prisma,
    /** Ligne d'incident telle qu'en base (référence vivante). */
    incident: (id: string) => incident.lignes.find((l) => l.id === id) as Ligne,
    suivis: (id: string) => suivis.filter((s) => s.incident_id === id),
    avis: (id: string) => prisma.avisPrive.lignes.find((l) => l.id === id) as Ligne,
    suivisAvis: (id: string) => prisma.avisPriveSuivi.lignes.filter((l) => l.avis_id === id),
  };
}

// ─── Jeu de données commun aux suites ───────────────────────────────────────

const personne = (id: string, role: string, restaurant: string | null, fullname: string): Ligne => ({
  id,
  role,
  type: restaurant ? 'RESTAURANT' : 'BACKOFFICE',
  restaurant_id: restaurant,
  fullname,
  entity_status: 'ACTIVE',
});

export const COMPTES = {
  admin: personne('u-admin', 'ADMIN', null, 'Cédric Assah'),
  callCenter: personne('u-cc', 'CALL_CENTER', null, 'Ruth Fetai'),
  callCenter2: personne('u-cc2', 'CALL_CENTER', null, 'Ange Yoboué'),
  marketing: personne('u-marketing', 'MARKETING', null, 'Marc Marketing'),
  livraisonOps: personne('u-ops', 'LIVRAISON_OPS', null, 'Olivier Ops'),
  manager: personne('u-manager', 'MANAGER', 'resto-1', 'Mariam Manager'),
  assistant: personne('u-assistant', 'ASSISTANT_MANAGER', 'resto-1', 'Aya Assistante'),
  caissier: personne('u-caissier', 'CAISSIER', 'resto-1', 'Koffi Caissier'),
  managerFaya: personne('u-manager-2', 'MANAGER', 'resto-2', 'Fatou Faya'),
};

/** Deux restaurants, deux clients, trois commandes, quatre catégories (dont une inactive), les comptes. */
export function jeuIncidents(plus: Parameters<typeof creerBaseIncidents>[0] = {}) {
  const jour = new Date('2026-11-10T19:40:00.000Z');
  return creerBaseIncidents({
    restaurants: [
      { id: 'resto-1', name: 'Angré' },
      { id: 'resto-2', name: 'Faya' },
    ],
    customers: [
      { id: 'client-1', first_name: 'Awa', last_name: 'Koné', phone: '+2250707000001' },
      { id: 'client-2', first_name: null, last_name: null, phone: '+2250505000002' },
    ],
    orders: [
      {
        id: 'commande-1',
        reference: 'ORD-261110-50950',
        restaurant_id: 'resto-1',
        customer_id: 'client-1',
        fullname: null,
        phone: null,
        created_at: jour,
        type: 'DELIVERY',
        status: 'COMPLETED',
        amount: 5500,
        entity_status: 'ACTIVE',
      },
      {
        id: 'commande-2',
        reference: 'ORD-261110-50951',
        restaurant_id: 'resto-2',
        customer_id: 'client-2',
        fullname: 'Mme Koffi',
        phone: '0505000002',
        created_at: jour,
        type: 'PICKUP',
        status: 'COLLECTED',
        amount: 9000,
        entity_status: 'ACTIVE',
      },
      {
        id: 'commande-3',
        reference: 'ORD-261109-40001',
        restaurant_id: 'resto-1',
        customer_id: 'client-1',
        fullname: null,
        phone: null,
        created_at: new Date('2026-11-09T12:00:00.000Z'),
        type: 'DELIVERY',
        status: 'COMPLETED',
        amount: 12000,
        entity_status: 'ACTIVE',
      },
    ],
    categories: [
      { id: 'cat-retard', nom: 'Livraison tardive', pole: 'LIVRAISON', delai_heures: 24, actif: true, ordre: 1 },
      { id: 'cat-qualite', nom: 'Qualité du plat', pole: 'RESTAURANT', delai_heures: 24, actif: true, ordre: 2 },
      { id: 'cat-paiement', nom: 'Paiement', pole: 'CALL_CENTER', delai_heures: 48, actif: true, ordre: 3 },
      { id: 'cat-ancienne', nom: 'Ancienne', pole: 'RESTAURANT', delai_heures: 24, actif: false, ordre: 4 },
    ],
    users: Object.values(COMPTES),
    vouchers: [],
    ...plus,
  });
}
