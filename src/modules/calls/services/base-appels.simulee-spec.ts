/**
 * Base en mémoire pour les tests des appels : personnel, livreurs, courses,
 * livraisons, réglages et table `calls`, avec Lunion Meet et la passerelle
 * simulés (aucun réseau, aucune base).
 *
 * Les `where` reçus sont ÉVALUÉS (AND, OR, null, not, in, has, comparaisons,
 * filtre de relation simple) : retirer une condition d'une écriture
 * conditionnée fait casser le test de la règle qu'elle porte. Chaque
 * `updateMany` est évalué et appliqué d'un seul tenant, comme un UPDATE ...
 * WHERE en base : deux décrochages simultanés ne peuvent pas gagner tous les
 * deux.
 *
 * Fichier de test seulement. Son nom finit par « -spec.ts » : exclu de la
 * construction sans être lancé comme une suite par jest.
 */
import { CourseStatut, EntityStatus, User, UserRole, UserType } from '@prisma/client';

import { CallsConfigService } from './calls-config.service';
import { CallsService } from './calls.service';
import { AppelsLivreurService, LivreurConnecte } from './appels-livreur.service';

type Ligne = Record<string, any>;

const egal = (a: unknown, b: unknown) =>
  a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b;

const OPERATEURS = ['not', 'in', 'has', 'gte', 'gt', 'lt', 'lte', 'equals'];

/** Le sous-ensemble des filtres Prisma employé par le module des appels. */
export function evaluer(ligne: Ligne | null | undefined, where: Ligne | undefined): boolean {
  if (!where) return true;
  if (!ligne) return false;
  for (const [cle, condition] of Object.entries(where)) {
    if (condition === undefined) continue;
    if (cle === 'AND') {
      const liste = Array.isArray(condition) ? condition : [condition];
      if (!liste.every((c) => evaluer(ligne, c))) return false;
      continue;
    }
    if (cle === 'OR') {
      if (!(condition as Ligne[]).some((c) => evaluer(ligne, c))) return false;
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
      if ('has' in c && !(Array.isArray(valeur) && valeur.includes(c.has))) return false;
      if ('gte' in c && !(valeur != null && valeur >= c.gte)) return false;
      if ('gt' in c && !(valeur != null && valeur > c.gt)) return false;
      if ('lt' in c && !(valeur != null && valeur < c.lt)) return false;
      if ('lte' in c && !(valeur != null && valeur <= c.lte)) return false;
      continue;
    }
    // Filtre de relation simple (`course: { deliverer_id: ... }`).
    if (!evaluer(valeur, c)) return false;
  }
  return true;
}

/** Les seuls champs demandés par un `select` (relations : `select` imbriqué). */
function projeter(ligne: Ligne | null | undefined, select?: Ligne): Ligne | null {
  if (!ligne) return null;
  if (!select) return { ...ligne };
  const sortie: Ligne = {};
  for (const [cle, demande] of Object.entries(select)) {
    if (!demande) continue;
    const valeur = ligne[cle];
    if (demande === true) sortie[cle] = valeur ?? null;
    else sortie[cle] = projeter(valeur, (demande as Ligne).select);
  }
  return sortie;
}

function trier(lignes: Ligne[], orderBy?: Ligne): Ligne[] {
  if (!orderBy) return lignes;
  const [cle, sens] = Object.entries(orderBy)[0];
  return [...lignes].sort((a, b) => {
    const x = a[cle] instanceof Date ? a[cle].getTime() : (a[cle] ?? 0);
    const y = b[cle] instanceof Date ? b[cle].getTime() : (b[cle] ?? 0);
    return sens === 'desc' ? y - x : x - y;
  });
}

export const RESTO_ANGRE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

let numero = 0;
const uuid = () => {
  numero++;
  return `00000000-0000-4000-8000-${String(numero).padStart(12, '0')}`;
};

export function membre(surcharge: Partial<User> = {}): User {
  return {
    id: uuid(),
    fullname: 'Agent',
    email: `agent${numero}@cn.test`,
    type: UserType.BACKOFFICE,
    role: UserRole.CALL_CENTER,
    restaurant_id: null,
    entity_status: EntityStatus.ACTIVE,
    ...surcharge,
  } as User;
}

export function livreur(surcharge: Ligne = {}): Ligne {
  return {
    id: uuid(),
    first_name: 'Koffi',
    last_name: 'Kouassi',
    phone: '+2250701020304',
    restaurant_id: RESTO_ANGRE,
    entity_status: EntityStatus.ACTIVE,
    is_operational: true,
    ...surcharge,
  };
}

export function course(surcharge: Ligne = {}): Ligne {
  return {
    id: uuid(),
    reference: 'CRS-A1',
    statut: CourseStatut.IN_DELIVERY,
    deliverer_id: null,
    assigned_at: new Date(),
    ...surcharge,
  };
}

/** Le livreur tel que JwtDelivererAuthGuard le pose sur la requête. */
export const connecte = (l: Ligne): LivreurConnecte => ({
  id: l.id,
  first_name: l.first_name,
  last_name: l.last_name,
  phone: l.phone,
  restaurant_id: l.restaurant_id,
});

export interface Evenement {
  salle: string;
  event: string;
  data: any;
}

export function monterAppels(donnees: {
  personnel?: User[];
  livreurs?: Ligne[];
  courses?: Ligne[];
  livraisons?: Ligne[];
  reglages?: Record<string, string>;
  enLigne?: boolean;
} = {}) {
  const personnel: Ligne[] = (donnees.personnel ?? []).map((u) => ({ ...u }));
  const livreurs: Ligne[] = donnees.livreurs ?? [];
  const courses: Ligne[] = donnees.courses ?? [];
  const livraisons: Ligne[] = donnees.livraisons ?? [];
  const restaurants: Ligne[] = [{ id: RESTO_ANGRE, name: 'Angré' }];
  const reglages: Record<string, string> = { ...(donnees.reglages ?? {}) };
  const appels: Ligne[] = [];

  const avecRestaurant = (l: Ligne | undefined) =>
    l ? { ...l, restaurant: restaurants.find((r) => r.id === l.restaurant_id) ?? null } : l;

  /** Relations d'un appel calculées à la lecture. */
  const relier = (a: Ligne): Ligne => ({
    ...a,
    caller: personnel.find((u) => u.id === a.caller_id) ?? null,
    answered_by: personnel.find((u) => u.id === a.answered_by_id) ?? null,
    target_user: personnel.find((u) => u.id === a.target_user_id) ?? null,
    target_restaurant: restaurants.find((r) => r.id === a.target_restaurant_id) ?? null,
    caller_deliverer: avecRestaurant(livreurs.find((l) => l.id === a.caller_deliverer_id)) ?? null,
    target_deliverer: avecRestaurant(livreurs.find((l) => l.id === a.target_deliverer_id)) ?? null,
    course: courses.find((c) => c.id === a.course_id) ?? null,
  });

  /** Ligne d'appel rendue avec ses inclusions demandées (ou nue). */
  const rendreAppel = (a: Ligne | undefined, args: Ligne = {}) => {
    if (!a) return null;
    const copie: Ligne = { ...a, ringing_user_ids: [...a.ringing_user_ids], rung_user_ids: [...a.rung_user_ids] };
    if (args.select) return projeter(relier(copie), args.select);
    if (!args.include) return copie;
    const relie = relier(copie);
    for (const [cle, demande] of Object.entries(args.include as Ligne)) {
      copie[cle] = demande === true ? relie[cle] : projeter(relie[cle], (demande as Ligne).select);
    }
    return copie;
  };

  const prisma = {
    call: {
      findUnique: jest.fn(async (args: Ligne) =>
        rendreAppel(appels.find((a) => a.id === args.where.id), args),
      ),
      findFirst: jest.fn(async (args: Ligne) =>
        rendreAppel(trier(appels.filter((a) => evaluer(a, args.where)), args.orderBy)[0], args),
      ),
      findMany: jest.fn(async (args: Ligne) =>
        trier(appels.filter((a) => evaluer(a, args.where)), args.orderBy).map((a) => rendreAppel(a, args)),
      ),
      create: jest.fn(async ({ data }: Ligne) => {
        const maintenant = new Date();
        const ligne: Ligne = {
          id: uuid(),
          room_name: null,
          caller_id: null,
          caller_type: null,
          caller_deliverer_id: null,
          target_restaurant_id: null,
          target_user_id: null,
          target_deliverer_id: null,
          course_id: null,
          order_id: null,
          answered_by_id: null,
          ringing_user_ids: [],
          rung_user_ids: [],
          started_at: maintenant,
          answered_at: null,
          ended_at: null,
          created_at: maintenant,
          updated_at: maintenant,
          ...data,
        };
        appels.push(ligne);
        return rendreAppel(ligne);
      }),
      updateMany: jest.fn(async ({ where, data }: Ligne) => {
        const visees = appels.filter((a) => evaluer(a, where));
        for (const a of visees) Object.assign(a, data, { updated_at: new Date() });
        return { count: visees.length };
      }),
    },
    // CallsService.reject : retrait atomique `array_remove` (UPDATE ... RETURNING).
    $queryRaw: jest.fn(async (_morceaux: TemplateStringsArray, userId: string, callId: string) => {
      const a = appels.find((x) => x.id === callId && x.status === 'RINGING');
      if (!a) return [];
      a.ringing_user_ids = a.ringing_user_ids.filter((id: string) => id !== userId);
      return [{ ringing_user_ids: [...a.ringing_user_ids] }];
    }),
    user: {
      findMany: jest.fn(async ({ where, select }: Ligne) =>
        personnel.filter((u) => evaluer(u, where)).map((u) => projeter(u, select)),
      ),
      findFirst: jest.fn(async ({ where, select }: Ligne) =>
        projeter(personnel.find((u) => evaluer(u, where)), select),
      ),
    },
    deliverer: {
      findUnique: jest.fn(async ({ where, select }: Ligne) =>
        projeter(avecRestaurant(livreurs.find((l) => l.id === where.id)), select),
      ),
      findFirst: jest.fn(async ({ where, select }: Ligne) =>
        projeter(avecRestaurant(livreurs.find((l) => evaluer(l, where))), select),
      ),
    },
    course: {
      findFirst: jest.fn(async ({ where, orderBy, select }: Ligne) =>
        projeter(trier(courses.filter((c) => evaluer(c, where)), orderBy)[0], select),
      ),
    },
    delivery: {
      findFirst: jest.fn(async ({ where, select }: Ligne) => {
        const relie = livraisons.map((d) => ({ ...d, course: courses.find((c) => c.id === d.course_id) }));
        return projeter(relie.find((d) => evaluer(d, where)), select);
      }),
    },
  };

  const evenements: Evenement[] = [];
  const gateway = {
    emitToUser: jest.fn((id: string, _type: string, event: string, data: unknown) =>
      evenements.push({ salle: `user_${id}`, event, data }),
    ),
    emitToDeliverer: jest.fn((id: string, event: string, data: unknown) =>
      evenements.push({ salle: `deliverer_${id}`, event, data }),
    ),
    isUserOnline: jest.fn(() => donnees.enLigne ?? true),
    livreurConnecte: jest.fn(async () => donnees.enLigne ?? true),
  };

  // Lunion Meet simulé : jamais de réseau, jamais de clé du service.
  let salles = 0;
  const lunion = {
    createRoom: jest.fn(async (name: string) => ({ id: `r${++salles}`, slug: `salle-${salles}`, name })),
    createToken: jest.fn(async (slug: string, identity: string, _name?: string, _ttl?: number) => ({
      token: `jeton:${slug}:${identity}`,
      url: 'wss://sfu.lunion.test',
      room: slug,
      identity,
    })),
    deleteRoom: jest.fn(async () => undefined),
  };

  const settings = {
    get: jest.fn(async (cle: string) => reglages[cle] ?? null),
    getJson: jest.fn(async () => null),
  };
  const push = { notifyAppelEntrant: jest.fn() };
  const audit = { record: jest.fn() };

  const config = new CallsConfigService(settings as never);
  const calls = new CallsService(prisma as never, lunion as never, config, gateway as never);
  const appelsLivreur = new AppelsLivreurService(
    prisma as never,
    lunion as never,
    config,
    calls,
    gateway as never,
    settings as never,
    push as never,
    audit as never,
  );

  /** Événements reçus par une salle (`user_{id}` ou `deliverer_{id}`), dans l'ordre. */
  const recus = (salle: string, event?: string) =>
    evenements.filter((e) => e.salle === salle && (!event || e.event === event));

  return { prisma, gateway, lunion, settings, push, audit, calls, appelsLivreur, appels, reglages, evenements, recus };
}
