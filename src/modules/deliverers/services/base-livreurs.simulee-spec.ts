/**
 * Base en mémoire pour les tests de la disponibilité des livreurs et de la
 * clôture des offres : livreurs, courses, offres et journal de la diffusion.
 *
 * Les `where` reçus sont ÉVALUÉS (AND, OR, NOT, null, not, in, notIn,
 * comparaisons, filtres de relation `none` / `some` / `every` sur les listes) :
 * retirer une condition d'une écriture conditionnée fait casser le test de la
 * règle qu'elle porte. Chaque `updateMany` est évalué et appliqué d'un seul
 * tenant, comme un UPDATE ... WHERE en base. Les lectures ne rendent que les
 * champs de leur `select`.
 *
 * Relations calculées à la lecture : `Deliverer.courses`,
 * `Deliverer.offer_attempts`, `CourseOfferAttempt.course`.
 *
 * Fichier de test seulement. Son nom finit par « -spec.ts » : exclu de la
 * construction sans être lancé comme une suite par jest.
 */
import { CourseStatut, DelivererStatus, EntityStatus } from '@prisma/client';

import { AppliLivreurService } from './appli-livreur.service';

type Ligne = Record<string, any>;

const egal = (a: unknown, b: unknown) =>
  a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b;

const OPERATEURS = ['not', 'in', 'notIn', 'gte', 'gt', 'lt', 'lte', 'equals'];
const FILTRES_LISTE = ['none', 'some', 'every'];

/** Le sous-ensemble des filtres Prisma employé ici, évalué en mémoire. */
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
    if (cle === 'NOT') {
      const liste = Array.isArray(condition) ? condition : [condition];
      if (liste.some((c) => evaluer(ligne, c))) return false;
      continue;
    }
    const valeur = ligne[cle];
    if (
      Array.isArray(valeur) &&
      condition &&
      typeof condition === 'object' &&
      Object.keys(condition).some((k) => FILTRES_LISTE.includes(k))
    ) {
      const c = condition as Ligne;
      if ('none' in c && valeur.some((v) => evaluer(v, c.none))) return false;
      if ('some' in c && !valeur.some((v) => evaluer(v, c.some))) return false;
      if ('every' in c && !valeur.every((v) => evaluer(v, c.every))) return false;
      continue;
    }
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
      if ('notIn' in c && (c.notIn as unknown[]).some((v) => egal(v, valeur))) return false;
      if ('gte' in c && !(valeur != null && valeur >= c.gte)) return false;
      if ('gt' in c && !(valeur != null && valeur > c.gt)) return false;
      if ('lt' in c && !(valeur != null && valeur < c.lt)) return false;
      if ('lte' in c && !(valeur != null && valeur <= c.lte)) return false;
      continue;
    }
    // Filtre de relation simple (`course: { statut: ... }`).
    if (!evaluer(valeur, c)) return false;
  }
  return true;
}

/** Les seuls champs demandés par un `select` (relations : `select` imbriqué ou ligne entière). */
function projeter(ligne: Ligne, select?: Ligne): Ligne {
  if (!select) return { ...ligne };
  const sortie: Ligne = {};
  for (const [cle, demande] of Object.entries(select)) {
    if (!demande) continue;
    const valeur = ligne[cle];
    if (demande === true) sortie[cle] = valeur;
    else if (valeur && typeof valeur === 'object' && !(valeur instanceof Date)) {
      sortie[cle] = projeter(valeur, (demande as Ligne).select);
    } else sortie[cle] = valeur ?? null;
  }
  return sortie;
}

function appliquer(ligne: Ligne, data: Ligne) {
  for (const [cle, valeur] of Object.entries(data)) {
    if (valeur && typeof valeur === 'object' && 'increment' in valeur) {
      ligne[cle] = (ligne[cle] ?? 0) + (valeur as Ligne).increment;
    } else ligne[cle] = valeur;
  }
}

export const RESTO = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

let numero = 0;
const ident = (prefixe: string) => `${prefixe}-${String(++numero).padStart(4, '0')}`;

/** Livreur actif, opérationnel, en service, sans pause. */
export function livreur(surcharge: Ligne = {}): Ligne {
  return {
    id: ident('livreur'),
    restaurant_id: RESTO,
    status: DelivererStatus.ACTIVE,
    is_operational: true,
    entity_status: EntityStatus.ACTIVE,
    pause_until: null,
    auto_pause_until: null,
    last_available_at: new Date('2026-10-22T09:00:00.000Z'),
    dernier_signal_at: null,
    protocole_appli: null,
    rappel_pause_at: null,
    expo_push_token: 'ExponentPushToken[essai]',
    refresh_token: 'jeton',
    last_location: null,
    last_location_at: null,
    type_vehicule: null,
    queue_penalty_until: null,
    queue_penalty_positions: 0,
    ...surcharge,
  };
}

export function course(surcharge: Ligne = {}): Ligne {
  const id = surcharge.id ?? ident('course');
  return {
    id,
    reference: `CRS-${id}`,
    restaurant_id: RESTO,
    statut: CourseStatut.PENDING_ASSIGNMENT,
    deliverer_id: null,
    turbo_escalated_at: null,
    offer_expires_at: null,
    refusal_count: 0,
    ...surcharge,
  };
}

export function offre(surcharge: Ligne = {}): Ligne {
  return {
    id: ident('offre'),
    status: 'PENDING',
    offered_at: new Date('2026-10-22T10:00:00.000Z'),
    expires_at: new Date('2026-10-22T10:02:00.000Z'),
    responded_at: null,
    reminders_sent: 0,
    ...surcharge,
  };
}

/** Monte la base et un faux Prisma qui l'interroge. */
export function monterBase(donnees: { livreurs?: Ligne[]; courses?: Ligne[]; offres?: Ligne[] } = {}) {
  const livreurs = donnees.livreurs ?? [];
  const courses = donnees.courses ?? [];
  const offres = donnees.offres ?? [];
  const journal: Ligne[] = [];
  const verrous: unknown[][] = [];

  const vueLivreur = (d: Ligne): Ligne => ({
    ...d,
    courses: courses.filter((c) => c.deliverer_id === d.id),
    offer_attempts: offres.filter((o) => o.deliverer_id === d.id),
  });
  const vueOffre = (o: Ligne): Ligne => ({
    ...o,
    course: courses.find((c) => c.id === o.course_id) ?? null,
  });
  const livreurDe = (id: string) => {
    const d = livreurs.find((x) => x.id === id);
    if (!d) throw Object.assign(new Error('Livreur introuvable'), { code: 'P2025' });
    return d;
  };

  const prisma: any = {
    deliverer: {
      findUnique: jest.fn(async ({ where, select }: Ligne) => {
        const d = livreurs.find((x) => x.id === where.id);
        return d ? projeter(vueLivreur(d), select) : null;
      }),
      findMany: jest.fn(async ({ where, select }: Ligne) =>
        livreurs.map(vueLivreur).filter((d) => evaluer(d, where)).map((d) => projeter(d, select)),
      ),
      findFirst: jest.fn(async ({ where, select }: Ligne) => {
        const d = livreurs.map(vueLivreur).find((x) => evaluer(x, where));
        return d ? projeter(d, select) : null;
      }),
      update: jest.fn(async ({ where, data, select }: Ligne) => {
        const d = livreurDe(where.id);
        appliquer(d, data);
        return projeter(vueLivreur(d), select);
      }),
      updateMany: jest.fn(async ({ where, data }: Ligne) => {
        const cibles = livreurs.filter((d) => evaluer(vueLivreur(d), where));
        cibles.forEach((d) => appliquer(d, data));
        return { count: cibles.length };
      }),
    },
    course: {
      findUnique: jest.fn(async ({ where, select }: Ligne) => {
        const c = courses.find((x) => x.id === where.id);
        return c ? projeter(c, select) : null;
      }),
      updateMany: jest.fn(async ({ where, data }: Ligne) => {
        const cibles = courses.filter((c) => evaluer(c, where));
        cibles.forEach((c) => appliquer(c, data));
        return { count: cibles.length };
      }),
    },
    courseOfferAttempt: {
      findMany: jest.fn(async ({ where, select }: Ligne) =>
        offres.map(vueOffre).filter((o) => evaluer(o, where)).map((o) => projeter(o, select)),
      ),
      findFirst: jest.fn(async ({ where, select }: Ligne) => {
        const o = offres.map(vueOffre).find((x) => evaluer(x, where));
        return o ? projeter(o, select) : null;
      }),
      updateMany: jest.fn(async ({ where, data }: Ligne) => {
        const cibles = offres.filter((o) => evaluer(vueOffre(o), where));
        cibles.forEach((o) => appliquer(o, data));
        return { count: cibles.length };
      }),
    },
    restaurant: {
      findUnique: jest.fn(async () => ({ latitude: 5.286, longitude: -3.9737 })),
    },
    dispatchEvenement: {
      create: jest.fn(async ({ data }: Ligne) => {
        const ligne = { id: ident('evenement'), created_at: new Date(), ...data };
        journal.push(ligne);
        return ligne;
      }),
    },
    // Verrous consultatifs notés ; transaction sans annulation (aucun test ici
    // n'en a besoin, voir base-dispatch.simulee-spec.ts pour la version complète).
    $executeRaw: jest.fn(async (_sql: TemplateStringsArray, ...valeurs: unknown[]) => {
      verrous.push(valeurs);
      return 1;
    }),
    $transaction: jest.fn(async (arg: unknown) =>
      Array.isArray(arg) ? Promise.all(arg) : (arg as (tx: unknown) => Promise<unknown>)(prisma),
    ),
  };

  return { prisma, livreurs, courses, offres, journal, verrous };
}

/** Faux bus d'événements : garde chaque émission. */
export function busSimule() {
  const emis: { canal: string; charge: any }[] = [];
  const bus = {
    emit: jest.fn((canal: string, charge: unknown) => {
      emis.push({ canal, charge });
      return true;
    }),
    emitAsync: jest.fn(async (canal: string, charge: unknown) => {
      emis.push({ canal, charge });
      return [];
    }),
  };
  return { bus, emis };
}

/**
 * Le VRAI service de l'appli du livreur (AppliLivreurService), branché sur une
 * base simulée :
 *  - `seuilS` : réglage `deliverer.appli_fermee_apres_s` (défaut 180, comme en
 *    production ; 0 coupe la règle) ;
 *  - `connectes` : sockets ouverts, `'tous'` (défaut : toutes les applis
 *    actives, pour les tests qui ne visent pas la règle), une liste d'ids, ou
 *    `null` (présence inconnue, Redis muet).
 * `gateway.livreursConnectes` note les livreurs dont la présence est demandée.
 */
export function appliLivreurSimulee(
  prisma: any,
  options: { seuilS?: number; connectes?: 'tous' | string[] | null } = {},
) {
  const etat = { seuilS: options.seuilS ?? 180, connectes: options.connectes === undefined ? 'tous' : options.connectes };
  const gateway = {
    livreursConnectes: jest.fn(async (ids: readonly string[]): Promise<Set<string> | null> => {
      if (etat.connectes === null) return null;
      const ouverts = etat.connectes;
      return new Set(ids.filter((id) => ouverts === 'tous' || ouverts.includes(id)));
    }),
  };
  const settings = { load: jest.fn(async () => ({ appliFermeeApresS: etat.seuilS })) };
  const service = new AppliLivreurService(prisma, gateway as never, settings as never);
  return { service, gateway, settings, etat };
}
