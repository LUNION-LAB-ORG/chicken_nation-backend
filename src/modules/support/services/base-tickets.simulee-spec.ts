/**
 * Tickets en mémoire, branchés sur une base simulée qui a déjà ses commandes
 * et ses livreurs (`base-dispatch.simulee-spec.ts`) : catégories, fils et
 * messages, ce que `DelivererTicketsService` lit et écrit.
 *
 *  - le code d'un fil est unique : une création avec un code déjà pris lève
 *    P2002, comme Prisma ; `collisions(n)` en fait lever n de plus, pour
 *    simuler un autre serveur qui prend le même code au même instant ;
 *  - `findUnique` rend le fil avec sa catégorie, sa commande, son livreur et
 *    ses messages, comme l'`include` du service ;
 *  - `findFirst` filtre aussi sur le sujet, le statut (`in`) et l'heure de
 *    création (`gte`), pour le rejeu d'un même ticket.
 *
 * Fichier de test seulement (nom en « -spec.ts » : exclu de la construction,
 * pas lancé comme une suite).
 */
import { EntityStatus, Prisma } from '@prisma/client';

type Ligne = Record<string, any>;

export const CATEGORIE_LIVRAISON = { id: 'cat-livraison', name: 'Problème de livraison', entity_status: EntityStatus.ACTIVE };
export const CATEGORIE_PAIEMENT = { id: 'cat-paiement', name: 'Paiement', entity_status: EntityStatus.ACTIVE };

const collision = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`code`)', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: ['code'] },
  });

function trier(liste: Ligne[], orderBy: Ligne | undefined): Ligne[] {
  if (!orderBy) return liste;
  const [cle, sens] = Object.entries(orderBy)[0] as [string, 'asc' | 'desc'];
  return [...liste].sort((a, b) => {
    const va = a[cle] instanceof Date ? a[cle].getTime() : a[cle];
    const vb = b[cle] instanceof Date ? b[cle].getTime() : b[cle];
    if (va === vb) return 0;
    return (va < vb ? -1 : 1) * (sens === 'desc' ? -1 : 1);
  });
}

function filtre(f: Ligne, where: Ligne | undefined): boolean {
  if (!where) return true;
  if (where.categoryId !== undefined && f.categoryId !== where.categoryId) return false;
  if (where.code?.startsWith !== undefined && !String(f.code).startsWith(where.code.startsWith)) return false;
  if (where.delivererId !== undefined && f.delivererId !== where.delivererId) return false;
  if (where.orderId !== undefined && f.orderId !== where.orderId) return false;
  if (where.subject !== undefined && f.subject !== where.subject) return false;
  if (where.status?.in !== undefined && !where.status.in.includes(f.status)) return false;
  if (where.createdAt?.gte !== undefined && !(f.createdAt >= where.createdAt.gte)) return false;
  return true;
}

export function brancherTickets(
  prisma: any,
  bases: { commandes: Ligne[]; livreurs: Ligne[] },
  categories: Ligne[] = [CATEGORIE_LIVRAISON],
) {
  const fils: Ligne[] = [];
  const messages: Ligne[] = [];
  let collisionsAVenir = 0;
  let horloge = Date.parse('2026-10-22T08:00:00.000Z');

  const vue = (f: Ligne): Ligne => {
    const commande = f.orderId ? bases.commandes.find((o) => o.id === f.orderId) : null;
    const livreur = f.delivererId ? bases.livreurs.find((d) => d.id === f.delivererId) : null;
    const categorie = categories.find((c) => c.id === f.categoryId);
    return {
      ...f,
      category: categorie ? { id: categorie.id, name: categorie.name } : null,
      order: commande ? { id: commande.id, reference: commande.reference, restaurant_id: commande.restaurant_id } : null,
      deliverer: livreur
        ? {
            id: livreur.id,
            first_name: livreur.first_name ?? null,
            last_name: livreur.last_name ?? null,
            phone: livreur.phone ?? null,
            image: null,
          }
        : null,
      assignee: null,
      messages: messages.filter((m) => m.ticketId === f.id),
      _count: { messages: 0 },
    };
  };

  prisma.ticketCategory = {
    findUnique: jest.fn(async ({ where }: Ligne) => categories.find((c) => c.id === where.id) ?? null),
    findMany: jest.fn(async (args: Ligne = {}) => {
      const liste = categories.filter(
        (c) => !args.where?.entity_status || c.entity_status === args.where.entity_status,
      );
      return trier(liste, args.orderBy).map((c) => ({ id: c.id, name: c.name }));
    }),
  };
  prisma.ticketThread = {
    findFirst: jest.fn(async (args: Ligne = {}) => trier(fils.filter((f) => filtre(f, args.where)), args.orderBy)[0] ?? null),
    findMany: jest.fn(async (args: Ligne = {}) => fils.filter((f) => filtre(f, args.where)).map(vue)),
    count: jest.fn(async (args: Ligne = {}) => fils.filter((f) => filtre(f, args.where)).length),
    create: jest.fn(async ({ data }: Ligne) => {
      if (collisionsAVenir > 0 || fils.some((f) => f.code === data.code)) {
        collisionsAVenir = Math.max(0, collisionsAVenir - 1);
        throw collision();
      }
      // Heure de création croissante, jamais avant l'heure du test (délai de rejeu).
      horloge = Math.max(horloge + 1000, Date.now());
      const ligne = { id: `fil-${fils.length + 1}`, createdAt: new Date(horloge), updatedAt: new Date(horloge), ...data };
      fils.push(ligne);
      return { ...ligne };
    }),
    findUnique: jest.fn(async ({ where }: Ligne) => {
      const f = fils.find((x) => x.id === where.id);
      return f ? vue(f) : null;
    }),
  };
  prisma.ticketMessage = {
    create: jest.fn(async ({ data }: Ligne) => {
      const ligne = { id: `message-${messages.length + 1}`, createdAt: new Date(horloge), ...data };
      messages.push(ligne);
      return { ...ligne };
    }),
  };
  // Base sans transaction (banc des tickets seul) : la fonction reçoit la base.
  if (!prisma.$transaction) prisma.$transaction = jest.fn(async (fn: (tx: unknown) => unknown) => fn(prisma));

  return {
    fils,
    messages,
    /** Les n prochaines créations de fil lèvent P2002 (code pris au même instant ailleurs). */
    collisions: (n: number) => {
      collisionsAVenir = n;
    },
  };
}
