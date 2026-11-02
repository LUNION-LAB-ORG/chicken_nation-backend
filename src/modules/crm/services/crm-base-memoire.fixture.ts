/**
 * Base en mémoire pour les tests des campagnes et de « Ma file ».
 *
 * Les services RÉELS tournent dessus : les `where` Prisma reçus sont ÉVALUÉS
 * (AND, OR, NOT, null, equals, not, in, notIn, comparaisons, relations à un
 * et à plusieurs), les tris aussi (relations comprises), et `groupBy` compte
 * vraiment. Une transaction qui lève une erreur est annulée, comme en base :
 * un lancement refusé laisse la campagne planifiée. Le `select` est ignoré,
 * chaque ligne revient avec ses relations.
 *
 * Seul le SQL brut n'est pas exécuté (aucun service testé ici n'en a besoin).
 */
type Ligne = Record<string, any>;

const OPERATEURS = new Set(['equals', 'not', 'in', 'notIn', 'lt', 'lte', 'gt', 'gte']);
const brut = (v: unknown) => (v instanceof Date ? v.getTime() : v);
const egal = (a: unknown, b: unknown) => brut(a) === brut(b);

function operateurs(v: any, c: Ligne): boolean {
  if ('equals' in c && !egal(v, c.equals)) return false;
  if ('not' in c) {
    if (c.not === null) {
      if (v === null || v === undefined) return false;
    } else if (typeof c.not === 'object' && !(c.not instanceof Date)) {
      if (operateurs(v, c.not)) return false;
    } else if (v === null || v === undefined || egal(v, c.not)) {
      // Comme en SQL : « <> valeur » écarte aussi NULL.
      return false;
    }
  }
  if ('in' in c && !(c.in as unknown[]).some((x) => egal(x, v))) return false;
  if ('notIn' in c && (v === null || v === undefined || (c.notIn as unknown[]).some((x) => egal(x, v)))) return false;
  const comparer = (op: string, ok: (a: any, b: any) => boolean) =>
    !(op in c) || (v !== null && v !== undefined && ok(brut(v), brut(c[op])));
  return (
    comparer('lt', (a, b) => a < b) &&
    comparer('lte', (a, b) => a <= b) &&
    comparer('gt', (a, b) => a > b) &&
    comparer('gte', (a, b) => a >= b)
  );
}

export function correspond(ligne: Ligne | null | undefined, where: Ligne | undefined): boolean {
  if (!where) return true;
  if (ligne === null || ligne === undefined) return false;
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
    if (Array.isArray(valeur)) {
      // Relation à plusieurs : membres, coupons…
      if ('some' in c && !valeur.some((x) => correspond(x, c.some))) return false;
      if ('none' in c && valeur.some((x) => correspond(x, c.none))) return false;
      if ('every' in c && !valeur.every((x) => correspond(x, c.every))) return false;
      continue;
    }
    const cles = Object.keys(c);
    if (cles.length > 0 && cles.every((k) => OPERATEURS.has(k))) {
      if (!operateurs(valeur, c)) return false;
      continue;
    }
    // Relation à un : campaign, assigned_to, contact… Sans ligne liée, la condition échoue.
    if (!correspond(valeur, c)) return false;
  }
  return true;
}

/** Tri façon PostgreSQL (NULL en dernier en croissant), relations comprises. */
function trier<T extends Ligne>(lignes: T[], orderBy: unknown): T[] {
  const regles: { chemin: string[]; sens: 'asc' | 'desc' }[] = [];
  const lire = (o: Ligne, chemin: string[]) => {
    for (const [champ, v] of Object.entries(o)) {
      if (typeof v === 'string') regles.push({ chemin: [...chemin, champ], sens: v as 'asc' | 'desc' });
      else if (v && typeof v === 'object' && 'sort' in v) regles.push({ chemin: [...chemin, champ], sens: (v as Ligne).sort });
      else if (v && typeof v === 'object') lire(v as Ligne, [...chemin, champ]);
    }
  };
  for (const o of (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []) as Ligne[]) lire(o, []);
  const valeurA = (l: Ligne, chemin: string[]) => chemin.reduce<any>((x, k) => (x == null ? x : x[k]), l);
  return [...lignes].sort((a, b) => {
    for (const { chemin, sens } of regles) {
      const x = brut(valeurA(a, chemin)) as any;
      const y = brut(valeurA(b, chemin)) as any;
      if (x == null && y == null) continue;
      if (x == null) return sens === 'asc' ? 1 : -1;
      if (y == null) return sens === 'asc' ? -1 : 1;
      if (x < y) return sens === 'asc' ? -1 : 1;
      if (x > y) return sens === 'asc' ? 1 : -1;
    }
    return 0;
  });
}

/** `data` d'une écriture, `{ increment: n }` compris. */
function appliquer(ligne: Ligne, data: Ligne) {
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    if (v && typeof v === 'object' && !(v instanceof Date) && 'increment' in v) ligne[k] = (ligne[k] ?? 0) + v.increment;
    else ligne[k] = v;
  }
}

let compteur = 0;
const nouvelId = (prefixe: string) => `${prefixe}-${String(++compteur).padStart(5, '0')}`;

export function utilisateur(id: string, fullname: string, role: string, surcharge: Ligne = {}): Ligne {
  return { id, fullname, role, type: 'BACKOFFICE', restaurant_id: null, entity_status: 'ACTIVE', ...surcharge };
}

export function contact(surcharge: Ligne = {}): Ligne {
  return {
    id: nouvelId('contact'),
    customer_id: null,
    phone: '0700000000',
    phone_key: null,
    name: null,
    registered_at: null,
    segment: 'JAMAIS_COMMANDE',
    segment_since: new Date('2026-09-01T00:00:00.000Z'),
    cycle: 1,
    last_order_at: null,
    status: 'A_APPELER',
    assigned_to_id: null,
    assigned_at: null,
    campaign_id: null,
    call_count: 0,
    last_call_at: null,
    last_call_status_id: null,
    last_call_outcome: null,
    callback_at: null,
    last_comment: null,
    coupon_sent_at: null,
    converted_at: null,
    conversion_amount: null,
    abandoned_orders: 0,
    entity_status: 'ACTIVE',
    ...surcharge,
  };
}

export function campagne(id: string, surcharge: Ligne = {}): Ligne {
  return {
    id,
    name: `Campagne ${id}`,
    description: null,
    status: 'PLANIFIED',
    start_date: new Date('2026-10-01T00:00:00.000Z'),
    end_date: null,
    lead_agent_id: null,
    created_by_id: null,
    distribution_mode: 'AUTOMATIQUE',
    registered_from: null,
    registered_to: null,
    segments: [],
    started_at: null,
    completed_at: null,
    targeted_count: 0,
    duration_days: null,
    suspended_at: null,
    suspension_alert_sent_at: null,
    launch_error: null,
    launch_failed_at: null,
    report: null,
    entity_status: 'ACTIVE',
    created_at: new Date('2026-09-20T00:00:00.000Z'),
    updated_at: new Date('2026-09-20T00:00:00.000Z'),
    ...surcharge,
  };
}

export function publicDe(campaign_id: string, segment: string, surcharge: Ligne = {}): Ligne {
  return {
    campaign_id,
    segment,
    period_from: null,
    period_to: null,
    restaurant_ids: [],
    account: null,
    relapsed_only: false,
    offer_id: null,
    targeted_count: 0,
    ...surcharge,
  };
}

export interface Donnees {
  users?: Ligne[];
  campagnes?: Ligne[];
  equipes?: { campaign_id: string; agent_id: string }[];
  publics?: Ligne[];
  contacts?: Ligne[];
  membres?: Ligne[];
}

export function monterBase(d: Donnees) {
  const tables = {
    users: d.users ?? [],
    campagnes: d.campagnes ?? [],
    equipes: d.equipes ?? [],
    publics: d.publics ?? [],
    contacts: d.contacts ?? [],
    membres: (d.membres ?? []) as Ligne[],
    evenements: [] as Ligne[],
    ecrituresCampagne: [] as Ligne[],
  };
  const { users, campagnes, equipes, publics, contacts, membres, evenements } = tables;

  const user = (id: string | null | undefined) => users.find((u) => u.id === id) ?? null;
  const campagneBrute = (id: string | null | undefined) => campagnes.find((c) => c.id === id) ?? null;
  const vueCampagne = (c: Ligne): Ligne => ({
    ...c,
    lead_agent: user(c.lead_agent_id),
    assigned_agents: equipes.filter((e) => e.campaign_id === c.id).map((e) => ({ ...e, agent: user(e.agent_id) })),
    publics: publics.filter((p) => p.campaign_id === c.id),
  });
  const vueContact = (c: Ligne): Ligne => ({
    customer: null,
    coupons: [],
    captures: [],
    last_call_status: null,
    loss_reason: null,
    ...c,
    campaign: c.campaign_id ? campagneBrute(c.campaign_id) : null,
    assigned_to: c.assigned_to_id ? user(c.assigned_to_id) : null,
    members: membres.filter((m) => m.contact_id === c.id),
  });
  const vueMembre = (m: Ligne): Ligne => ({
    ...m,
    contact: vueContact(contacts.find((c) => c.id === m.contact_id)!),
    campaign: campagneBrute(m.campaign_id),
  });

  function table<T extends Ligne>(lignes: T[], vue: (l: T) => Ligne, unique?: (a: Ligne, b: Ligne) => boolean, prefixe = 'ligne') {
    const filtrer = (where?: Ligne) => lignes.filter((l) => correspond(vue(l), where));
    return {
      findMany: async ({ where, orderBy, take, skip }: Ligne = {}) => {
        const l = trier(lignes.map(vue).filter((x) => correspond(x, where)), orderBy);
        return l.slice(skip ?? 0, take ? (skip ?? 0) + take : undefined);
      },
      findFirst: async ({ where, orderBy }: Ligne = {}) =>
        trier(lignes.map(vue).filter((x) => correspond(x, where)), orderBy)[0] ?? null,
      findUnique: async ({ where }: Ligne) => {
        const cle = Object.values(where)[0];
        const w = cle && typeof cle === 'object' && !(cle instanceof Date) ? cle : where;
        return lignes.map(vue).find((x) => correspond(x, w as Ligne)) ?? null;
      },
      count: async ({ where }: Ligne = {}) => filtrer(where).length,
      groupBy: async ({ by, where, _count }: Ligne) => {
        const groupes = new Map<string, Ligne>();
        for (const l of filtrer(where)) {
          const cle = JSON.stringify((by as string[]).map((k) => l[k] ?? null));
          const g = groupes.get(cle) ?? { ...Object.fromEntries((by as string[]).map((k) => [k, l[k] ?? null])), _count: { _all: 0 } };
          g._count._all++;
          groupes.set(cle, g);
        }
        return [...groupes.values()].map((g) => (_count ? g : { ...g, _count: undefined }));
      },
      updateMany: async ({ where, data }: Ligne) => {
        const visees = filtrer(where);
        visees.forEach((l) => appliquer(l, data));
        return { count: visees.length };
      },
      /** Comme UPDATE ... RETURNING : seules les lignes écrites par CET appel reviennent. */
      updateManyAndReturn: async ({ where, data }: Ligne) => {
        const visees = filtrer(where);
        visees.forEach((l) => appliquer(l, data));
        return visees.map(vue);
      },
      update: async ({ where, data }: Ligne) => {
        const l = filtrer(where)[0];
        if (!l) throw new Error('Ligne introuvable');
        appliquer(l, data);
        return vue(l);
      },
      create: async ({ data }: Ligne) => {
        const l = { id: nouvelId(prefixe), ...data } as unknown as T;
        lignes.push(l);
        return vue(l);
      },
      createMany: async ({ data }: Ligne) => {
        let n = 0;
        for (const x of data as Ligne[]) {
          if (unique && lignes.some((l) => unique(l, x))) continue;
          lignes.push({ id: nouvelId(prefixe), ...x } as unknown as T);
          n++;
        }
        return { count: n };
      },
      deleteMany: async ({ where }: Ligne = {}) => {
        const visees = new Set(filtrer(where));
        const avant = lignes.length;
        for (let i = lignes.length - 1; i >= 0; i--) if (visees.has(lignes[i])) lignes.splice(i, 1);
        return { count: avant - lignes.length };
      },
    };
  }

  const prisma: any = {
    user: table(users, (u) => u, undefined, 'user'),
    crmCampaign: table(campagnes, vueCampagne, undefined, 'campagne'),
    crmCampaignAgent: table(
      equipes as Ligne[],
      (e) => ({ ...e, campaign_id_agent_id: { campaign_id: e.campaign_id, agent_id: e.agent_id }, agent: user(e.agent_id) }),
      (a, b) => a.campaign_id === b.campaign_id && a.agent_id === b.agent_id,
    ),
    crmCampaignPublic: table(publics, (p) => p, (a, b) => a.campaign_id === b.campaign_id && a.segment === b.segment),
    crmCampaignMember: table(
      membres,
      vueMembre,
      (a, b) => a.campaign_id === b.campaign_id && a.contact_id === b.contact_id,
      'membre',
    ),
    crmContact: table(contacts, vueContact, undefined, 'contact'),
    crmEvent: table(evenements, (e) => e, undefined, 'evenement'),
    crmCall: { count: async () => 0 },
    crmCoupon: { count: async () => 0 },
    /** Annulée si elle lève une erreur, comme une vraie transaction. */
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const copie = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.map((l: Ligne) => structuredClone(l))]));
      try {
        return await fn(prisma);
      } catch (e) {
        for (const [k, v] of Object.entries(copie)) {
          const t = (tables as Record<string, Ligne[]>)[k];
          t.splice(0, t.length, ...v);
        }
        throw e;
      }
    },
  };

  return { prisma, ...tables };
}
