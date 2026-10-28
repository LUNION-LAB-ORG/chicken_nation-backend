/**
 * Base en mémoire pour les tests de la diffusion côté course : livreurs,
 * courses, livraisons, commandes, offres et journal, avec leurs relations.
 *
 * Comme `base-livreurs.simulee-spec.ts` (dont elle reprend l'évaluation des
 * `where`) : les filtres sont ÉVALUÉS, y compris à travers les relations
 * (`order: { status }`, `delivery: { course_id }`, `courses: { none }`), et
 * chaque `updateMany` est un UPDATE ... WHERE d'un seul tenant. En plus :
 *  - `select`, `include` et `_count` (avec `where`) sont projetés ;
 *  - `update` avec une condition qui ne correspond plus lève P2025, comme
 *    Prisma ;
 *  - `$transaction(fn)` ANNULE ses écritures, et seulement les siennes, si
 *    `fn` lève (les colonnes écrites retrouvent leur valeur, les créations
 *    disparaissent) ; la forme tableau attend simplement ses opérations ;
 *  - `$executeRaw` (verrous consultatifs) est noté dans `verrous` ;
 *  - `$queryRaw` répond à `pg_try_advisory_xact_lock` : le verrou est tenu
 *    jusqu'à la fin de la transaction qui l'a pris (deux « serveurs » qui
 *    partagent la base se l'arrachent comme en vrai), rendu tout de suite
 *    hors transaction ;
 *  - `deleteMany` est un DELETE ... WHERE ;
 *  - `course.create` crée aussi ses livraisons imbriquées (`deliveries.create`) ;
 *  - `dispatchEvenement.groupBy` (`by`, `where`, `_max`) regroupe le journal ;
 *  - `dispatchEvenement.findFirst` suit `orderBy` (à égalité, l'ordre d'écriture).
 *
 * Fichier de test seulement. Son nom finit par « -spec.ts » : exclu de la
 * construction sans être lancé comme une suite par jest.
 */
import { CourseStatut, DeliveryService, DeliveryStatut, EntityStatus, OrderStatus, OrderType, Prisma } from '@prisma/client';

import { evaluer, livreur, offre, RESTO } from 'src/modules/deliverers/services/base-livreurs.simulee-spec';

export { livreur, offre, RESTO };

type Ligne = Record<string, any>;

let numero = 0;
const ident = (prefixe: string) => `${prefixe}-${String(++numero).padStart(4, '0')}`;

export function course(surcharge: Ligne = {}): Ligne {
  const id = surcharge.id ?? ident('course');
  return {
    id,
    reference: `CRS-${id}`,
    pickup_code: '421',
    restaurant_id: RESTO,
    statut: CourseStatut.PENDING_ASSIGNMENT,
    deliverer_id: null,
    turbo_escalated_at: null,
    offer_expires_at: null,
    refusal_count: 0,
    no_deliverer_alerted_at: null,
    assigned_at: null,
    at_restaurant_at: null,
    picked_up_at: null,
    completed_at: null,
    cancelled_at: null,
    cancelled_by: null,
    cancelled_reason: null,
    total_delivery_fee: 0,
    estimated_duration_min: null,
    retenue_jusqua: null,
    commandes_attendues: null,
    parti_at: null,
    motif_depart: null,
    motif_regroupement: null,
    created_at: new Date('2026-10-22T09:30:00.000Z'),
    updated_at: new Date('2026-10-22T09:30:00.000Z'),
    ...surcharge,
  };
}

export function commande(surcharge: Ligne = {}): Ligne {
  const id = surcharge.id ?? ident('commande');
  return {
    id,
    reference: `CMD-${id}`,
    restaurant_id: RESTO,
    status: OrderStatus.READY,
    type: OrderType.DELIVERY,
    delivery_service: DeliveryService.CHICKEN_NATION,
    entity_status: EntityStatus.ACTIVE,
    delivery_fee: 1000,
    address: null,
    picked_up_at: null,
    cancelled_at: null,
    recovery_code: null,
    batch_id: null,
    created_at: new Date('2026-10-22T09:30:00.000Z'),
    updated_at: new Date('2026-10-22T09:30:00.000Z'),
    prepared_at: null,
    ready_at: null,
    estimated_preparation_time: null,
    date: null,
    time: null,
    ...surcharge,
  };
}

export function livraison(surcharge: Ligne = {}): Ligne {
  return {
    id: ident('livraison'),
    statut: DeliveryStatut.PENDING,
    sequence_order: 1,
    delivery_pin: '1234',
    in_route_at: null,
    arrived_at: null,
    ajoutee_at: null,
    ajoutee_apres_retrait: false,
    ...surcharge,
  };
}

/** Ajoute des propriétés calculées (relations), non énumérables : `{ ...vue }` ne garde que les colonnes. */
function avecRelations(ligne: Ligne, relations: Record<string, () => unknown>): Ligne {
  const vue: Ligne = { ...ligne };
  for (const [cle, calcul] of Object.entries(relations)) {
    Object.defineProperty(vue, cle, { get: calcul, enumerable: false });
  }
  return vue;
}

function trier(liste: Ligne[], orderBy: Ligne | Ligne[] | undefined): Ligne[] {
  if (!orderBy) return liste;
  const criteres = Array.isArray(orderBy) ? orderBy : [orderBy];
  return [...liste].sort((a, b) => {
    for (const critere of criteres) {
      const [cle, sens] = Object.entries(critere)[0] as [string, 'asc' | 'desc'];
      const va = a[cle] instanceof Date ? a[cle].getTime() : a[cle];
      const vb = b[cle] instanceof Date ? b[cle].getTime() : b[cle];
      if (va === vb) continue;
      const ordre = va < vb ? -1 : 1;
      return sens === 'desc' ? -ordre : ordre;
    }
    return 0;
  });
}

function compter(vue: Ligne, select: Ligne): Ligne {
  const sortie: Ligne = {};
  for (const [cle, demande] of Object.entries(select)) {
    const liste = (vue[cle] as Ligne[]) ?? [];
    sortie[cle] = demande === true ? liste.length : liste.filter((v) => evaluer(v, demande.where)).length;
  }
  return sortie;
}

function projeterValeur(valeur: unknown, demande: any): unknown {
  if (Array.isArray(valeur)) {
    if (demande === true) return valeur.map((v) => ({ ...v }));
    let liste = valeur.filter((v) => evaluer(v, demande.where));
    liste = trier(liste, demande.orderBy);
    if (demande.take !== undefined) liste = liste.slice(0, demande.take);
    return liste.map((v) => projeter(v, demande));
  }
  if (valeur === null || valeur === undefined) return null;
  if (demande === true) return valeur instanceof Date || typeof valeur !== 'object' ? valeur : { ...(valeur as Ligne) };
  return projeter(valeur as Ligne, demande);
}

/** Projection d'une vue selon `select` ou `include` (comme Prisma). */
export function projeter(vue: Ligne, args: { select?: Ligne; include?: Ligne } = {}): Ligne {
  if (args.select) {
    const sortie: Ligne = {};
    for (const [cle, demande] of Object.entries(args.select)) {
      if (!demande) continue;
      if (cle === '_count') sortie._count = compter(vue, demande.select);
      else sortie[cle] = projeterValeur(vue[cle], demande);
    }
    return sortie;
  }
  const sortie: Ligne = { ...vue };
  for (const [cle, demande] of Object.entries(args.include ?? {})) {
    if (!demande) continue;
    if (cle === '_count') sortie._count = compter(vue, demande.select);
    else sortie[cle] = projeterValeur(vue[cle], demande);
  }
  return sortie;
}

/** Écritures d'une transaction, pour les annuler : colonnes et valeurs d'avant, lignes créées. */
type Annulation = (() => void)[];

function appliquer(ligne: Ligne, data: Ligne, annulation?: Annulation) {
  if (annulation) {
    const avant = Object.fromEntries(Object.keys(data).map((cle) => [cle, ligne[cle]]));
    annulation.push(() => Object.assign(ligne, avant));
  }
  for (const [cle, valeur] of Object.entries(data)) {
    if (valeur && typeof valeur === 'object' && !(valeur instanceof Date) && 'increment' in valeur) {
      ligne[cle] = (ligne[cle] ?? 0) + (valeur as Ligne).increment;
    } else ligne[cle] = valeur;
  }
}

const introuvable = () =>
  new Prisma.PrismaClientKnownRequestError('Aucune ligne ne correspond', {
    code: 'P2025',
    clientVersion: 'test',
  });

export interface DonneesDispatch {
  livreurs?: Ligne[];
  courses?: Ligne[];
  livraisons?: Ligne[];
  commandes?: Ligne[];
  offres?: Ligne[];
}

export function monterBaseDispatch(donnees: DonneesDispatch = {}) {
  const livreurs = donnees.livreurs ?? [];
  const courses = donnees.courses ?? [];
  const livraisons = donnees.livraisons ?? [];
  const commandes = donnees.commandes ?? [];
  const offres = donnees.offres ?? [];
  const journal: Ligne[] = [];
  const verrous: unknown[][] = [];
  const restaurant = { id: RESTO, name: 'Zone 4', latitude: 5.286, longitude: -3.9737, apikey: 'cle' };

  const vueLivreur = (d: Ligne): Ligne =>
    avecRelations(d, {
      courses: () => courses.filter((c) => c.deliverer_id === d.id).map(vueCourse),
      offer_attempts: () => offres.filter((o) => o.deliverer_id === d.id).map(vueOffre),
    });
  const vueCommande = (o: Ligne): Ligne =>
    avecRelations(o, {
      delivery: () => {
        const l = livraisons.find((x) => x.order_id === o.id);
        return l ? vueLivraison(l) : null;
      },
    });
  const vueLivraison = (l: Ligne): Ligne =>
    avecRelations(l, {
      order: () => vueCommande(commandes.find((o) => o.id === l.order_id)!),
      course: () => {
        const c = courses.find((x) => x.id === l.course_id);
        return c ? vueCourse(c) : null;
      },
    });
  const vueCourse = (c: Ligne): Ligne =>
    avecRelations(c, {
      deliveries: () => trier(livraisons.filter((l) => l.course_id === c.id), { sequence_order: 'asc' }).map(vueLivraison),
      deliverer: () => {
        const d = livreurs.find((x) => x.id === c.deliverer_id);
        return d ? vueLivreur(d) : null;
      },
      offer_attempts: () => offres.filter((o) => o.course_id === c.id).map(vueOffre),
      restaurant: () => restaurant,
    });
  const vueOffre = (o: Ligne): Ligne =>
    avecRelations(o, {
      course: () => {
        const c = courses.find((x) => x.id === o.course_id);
        return c ? vueCourse(c) : null;
      },
      deliverer: () => {
        const d = livreurs.find((x) => x.id === o.deliverer_id);
        return d ? vueLivreur(d) : null;
      },
    });

  /**
   * Création imbriquée (`course.create({ data: { deliveries: { create: [...] } } })`) :
   * les livraisons naissent dans leur table, rattachées à la course créée.
   */
  const enfantsDe: Record<string, Record<string, (parent: Ligne, donnees: Ligne) => Ligne>> = {
    course: {
      deliveries: (parent, donnees) => {
        const ligne = livraison({ ...donnees, course_id: parent.id });
        livraisons.push(ligne);
        return ligne;
      },
    },
  };

  /** Délégué Prisma générique sur une table (écritures notées si `annulation` est fourni). */
  function table(lignes: Ligne[], vue: (l: Ligne) => Ligne, prefixe: string, annulation?: Annulation) {
    const lire = (where: Ligne | undefined) => lignes.map(vue).filter((v) => evaluer(v, where));
    const unique = (where: Ligne) => lignes.find((l) => evaluer(vue(l), where));
    return {
      findMany: jest.fn(async (args: Ligne = {}) => {
        let liste = trier(lire(args.where), args.orderBy);
        if (args.take !== undefined) liste = liste.slice(0, args.take);
        return liste.map((v) => projeter(v, args));
      }),
      findFirst: jest.fn(async (args: Ligne = {}) => {
        const v = trier(lire(args.where), args.orderBy)[0];
        return v ? projeter(v, args) : null;
      }),
      findUnique: jest.fn(async (args: Ligne) => {
        const l = unique(args.where);
        return l ? projeter(vue(l), args) : null;
      }),
      findUniqueOrThrow: jest.fn(async (args: Ligne) => {
        const l = unique(args.where);
        if (!l) throw introuvable();
        return projeter(vue(l), args);
      }),
      count: jest.fn(async (args: Ligne = {}) => lire(args.where).length),
      update: jest.fn(async (args: Ligne) => {
        const l = unique(args.where);
        if (!l) throw introuvable();
        appliquer(l, args.data, annulation);
        return projeter(vue(l), args);
      }),
      updateMany: jest.fn(async (args: Ligne) => {
        const cibles = lignes.filter((l) => evaluer(vue(l), args.where));
        cibles.forEach((l) => appliquer(l, args.data, annulation));
        return { count: cibles.length };
      }),
      create: jest.fn(async (args: Ligne) => {
        const imbriquees = enfantsDe[prefixe] ?? {};
        const colonnes = Object.fromEntries(Object.entries(args.data).filter(([cle]) => !imbriquees[cle]));
        const ligne = { id: ident(prefixe), created_at: new Date(), ...colonnes };
        lignes.push(ligne);
        annulation?.push(() => {
          const i = lignes.indexOf(ligne);
          if (i >= 0) lignes.splice(i, 1);
        });
        for (const [relation, creer] of Object.entries(imbriquees)) {
          const aCreer = (args.data[relation] as Ligne | undefined)?.create;
          for (const donnees of aCreer ? (Array.isArray(aCreer) ? aCreer : [aCreer]) : []) {
            const enfant = creer(ligne, donnees);
            annulation?.push(() => {
              const i = livraisons.indexOf(enfant);
              if (i >= 0) livraisons.splice(i, 1);
            });
          }
        }
        return projeter(vue(ligne), args);
      }),
      deleteMany: jest.fn(async (args: Ligne = {}) => {
        const cibles = lignes.filter((l) => evaluer(vue(l), args.where));
        for (const l of cibles) {
          const i = lignes.indexOf(l);
          lignes.splice(i, 1);
          annulation?.push(() => lignes.push(l));
        }
        return { count: cibles.length };
      }),
      delete: jest.fn(async (args: Ligne) => {
        const i = lignes.findIndex((l) => evaluer(vue(l), args.where));
        if (i < 0) throw introuvable();
        const [supprimee] = lignes.splice(i, 1);
        annulation?.push(() => lignes.push(supprimee));
        return supprimee;
      }),
      aggregate: jest.fn(async (args: Ligne) => {
        const liste = lire(args.where);
        const sortie: Ligne = {};
        for (const [cle, champs] of Object.entries(args)) {
          if (cle !== '_max') continue;
          sortie._max = Object.fromEntries(
            Object.keys(champs as Ligne).map((c) => [c, liste.length ? Math.max(...liste.map((v) => v[c])) : null]),
          );
        }
        return sortie;
      }),
    };
  }

  const tables = (annulation?: Annulation) => ({
    deliverer: table(livreurs, vueLivreur, 'livreur', annulation),
    course: table(courses, vueCourse, 'course', annulation),
    delivery: table(livraisons, vueLivraison, 'livraison', annulation),
    order: table(commandes, vueCommande, 'commande', annulation),
    courseOfferAttempt: table(offres, vueOffre, 'offre', annulation),
  });

  /** Verrous consultatifs « essayés » (`pg_try_advisory_xact_lock`) tenus en ce moment. */
  const verrousTenus = new Set<string>();
  const essayerVerrou = (valeurs: unknown[], tenusParLaTransaction: string[] | null) => {
    verrous.push(valeurs);
    const cle = valeurs.map(String).join(':');
    if (verrousTenus.has(cle)) return [{ pris: false }];
    if (tenusParLaTransaction) {
      verrousTenus.add(cle);
      tenusParLaTransaction.push(cle);
    }
    return [{ pris: true }];
  };

  const prisma: any = {
    ...tables(),
    restaurant: { findUnique: jest.fn(async () => restaurant) },
    $queryRaw: jest.fn(async (_sql: TemplateStringsArray, ...valeurs: unknown[]) => essayerVerrou(valeurs, null)),
    dispatchEvenement: {
      create: jest.fn(async ({ data }: Ligne) => {
        const ligne = { id: ident('evenement'), created_at: new Date(), ...data };
        journal.push(ligne);
        return ligne;
      }),
      createMany: jest.fn(async ({ data }: { data: Ligne[] }) => {
        for (const d of data) journal.push({ id: ident('evenement'), created_at: new Date(), ...d });
        return { count: data.length };
      }),
      findFirst: jest.fn(async (args: Ligne = {}) => {
        const ligne = trier(
          journal.filter((l) => evaluer(l, args.where)),
          args.orderBy,
        )[0];
        return ligne ? projeter(ligne, args) : null;
      }),
      groupBy: jest.fn(async (args: Ligne) => {
        const groupes = new Map<string, Ligne[]>();
        for (const l of journal.filter((x) => evaluer(x, args.where))) {
          const cle = JSON.stringify((args.by as string[]).map((b) => l[b]));
          groupes.set(cle, [...(groupes.get(cle) ?? []), l]);
        }
        const valeur = (v: unknown) => (v instanceof Date ? v.getTime() : (v as number));
        return [...groupes.values()].map((g) => ({
          ...Object.fromEntries((args.by as string[]).map((b) => [b, g[0][b]])),
          ...(args._max
            ? {
                _max: Object.fromEntries(
                  Object.keys(args._max).map((c) => [
                    c,
                    g.reduce<unknown>((m, l) => (m === null || valeur(l[c]) > valeur(m) ? l[c] : m), null),
                  ]),
                ),
              }
            : {}),
        }));
      }),
    },
    $executeRaw: jest.fn(async (_sql: TemplateStringsArray, ...valeurs: unknown[]) => {
      verrous.push(valeurs);
      return 1;
    }),
    $transaction: jest.fn(async (arg: unknown) => {
      if (Array.isArray(arg)) return Promise.all(arg);
      const annulation: Annulation = [];
      const tenus: string[] = [];
      const tx = {
        ...prisma,
        ...tables(annulation),
        $queryRaw: jest.fn(async (_sql: TemplateStringsArray, ...valeurs: unknown[]) => essayerVerrou(valeurs, tenus)),
      };
      try {
        return await (arg as (tx: unknown) => Promise<unknown>)(tx);
      } catch (err) {
        for (const annuler of annulation.reverse()) annuler();
        throw err;
      } finally {
        tenus.forEach((cle) => verrousTenus.delete(cle));
      }
    }),
  };

  return { prisma, livreurs, courses, livraisons, commandes, offres, journal, verrous, verrousTenus, restaurant };
}

/** Une course, ses commandes et ses livraisons, rangées dans les tableaux de la base. */
export function courseAvecCommandes(
  surchargeCourse: Ligne,
  statutsCommandes: OrderStatus[],
  frais = 1000,
): { course: Ligne; commandes: Ligne[]; livraisons: Ligne[] } {
  const c = course(surchargeCourse);
  const commandes = statutsCommandes.map((status) => commande({ status, delivery_fee: frais }));
  const livraisons = commandes.map((o, i) =>
    livraison({ course_id: c.id, order_id: o.id, sequence_order: i + 1 }),
  );
  return { course: c, commandes, livraisons };
}
