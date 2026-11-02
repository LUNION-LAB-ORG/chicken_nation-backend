/**
 * ANNUAIRE (segment CLIENT) ET SYNCHRONISATION, corrigés le 02/11.
 *
 * Défaut constaté en production depuis le 24/10 : une fiche « non démarchée »
 * entrait avec comme date d'entrée sa DERNIÈRE commande, que la
 * synchronisation prenait aussitôt pour une conversion. La fiche passait
 * « Converti » et une fausse vente du centre d'appels entrait au registre.
 *
 * Règles vérifiées ici :
 *  - une fiche NON_DEMARCHE ne se convertit jamais ;
 *  - une fiche prise en charge ne compte qu'une commande passée APRÈS la prise ;
 *  - une fiche d'annuaire jamais travaillée, rétablie, revient « non démarchée » ;
 *  - le rétablissement relit la campagne dans sa transaction, verrouillée.
 */
import { CrmCallOutcome, CrmSegment, CrmStatus, EntityStatus } from '@prisma/client';
import { CrmRattrapageService } from './crm-rattrapage.service';
import { CrmSyncService, DEBUT_VENTES_SQL, debutVentes } from './crm-sync.service';

const JOUR = 86_400_000;
const MAINTENANT = Date.now();
const DERNIERE = new Date(MAINTENANT - 10 * JOUR);
const PRISE = new Date(MAINTENANT - 2 * JOUR);

type Commande = { id: string; created_at: Date; amount: number };

function fiche(surcharge: Record<string, unknown> = {}) {
  return {
    id: 'x1',
    customer_id: 'u1',
    status: CrmStatus.NON_DEMARCHE as CrmStatus,
    segment: CrmSegment.CLIENT as CrmSegment,
    segment_since: DERNIERE,
    cycle: 1,
    last_order_at: DERNIERE,
    abandoned_orders: 0,
    last_call_outcome: null as CrmCallOutcome | null,
    call_count: 0,
    conversion_order_id: null as string | null,
    converted_at: null as Date | null,
    campaign_id: null as string | null,
    assigned_to_id: null as string | null,
    entity_status: EntityStatus.ACTIVE,
    customer: { entity_status: EntityStatus.ACTIVE },
    ...surcharge,
  };
}

/** Faux Prisma : les commandes du client, ses coupons, et la campagne lue verrouillée. */
function monter(
  contact: ReturnType<typeof fiche>,
  commandes: Commande[],
  options: { coupons?: number; campagne?: string | null } = {},
) {
  const ecrites: Record<string, any>[] = [];
  const mises: Record<string, any>[] = [];
  const credits: { agent: string | null; commande: string }[] = [];
  const journal: { label: string }[] = [];
  const lectures: string[] = [];
  const effectives = commandes.map((o) => ({ reference: `REF-${o.id}`, code_promo: null, restaurant_id: 'r1', ...o }));

  const tx = {
    crmContact: {
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (where.status === CrmStatus.CONVERTI && contact.status !== CrmStatus.CONVERTI) return { count: 0 };
        if (where.status?.not === CrmStatus.CONVERTI && contact.status === CrmStatus.CONVERTI) return { count: 0 };
        ecrites.push(data);
        Object.assign(contact, data);
        return { count: 1 };
      }),
    },
    crmCampaignMember: { updateMany: jest.fn(async () => ({ count: 0 })) },
    crmCoupon: { count: jest.fn(async () => 0) },
    $queryRaw: jest.fn(async (morceaux: TemplateStringsArray) => {
      lectures.push(morceaux.join('?'));
      return options.campagne ? [{ status: options.campagne }] : [];
    }),
  };
  const prisma = {
    crmContact: {
      findUnique: jest.fn(async () => ({ ...contact })),
      update: jest.fn(async ({ data }: any) => (mises.push(data), Object.assign(contact, data))),
    },
    crmCoupon: {
      // Coupon valable : aucun. Coupons de la fiche : `options.coupons`.
      count: jest.fn(async ({ where }: any) => (where.used_at === null ? 0 : (options.coupons ?? 0))),
    },
    order: {
      findFirst: jest.fn(async ({ where, orderBy }: any) => {
        if (where.id) return effectives.find((o) => o.id === where.id) ?? null;
        const depuis: Date | undefined = where.created_at?.gte;
        const liste = effectives
          .filter((o) => !depuis || o.created_at >= depuis)
          .sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
        if (liste.length === 0) return null;
        return orderBy?.created_at === 'desc' ? liste[liste.length - 1] : liste[0];
      }),
      count: jest.fn(async () => 0),
    },
    $queryRaw: jest.fn(async () => []),
    $transaction: jest.fn(async (travail: (t: typeof tx) => Promise<unknown>) => travail(tx)),
  };
  const service = Object.create(CrmSyncService.prototype) as CrmSyncService;
  Object.assign(service, {
    prisma,
    config: { joursInactivite: async () => 30 },
    events: { journaliser: jest.fn(async (l: { label: string }[]) => journal.push(...l)), signaler: jest.fn() },
    registre: {
      crediter: jest.fn(async (_tx: unknown, c: any, o: any) => (credits.push({ agent: c.assigned_to_id, commande: o.id }), true)),
      annuler: jest.fn(async () => undefined),
    },
    identite: {},
  });
  return { service, contact, ecrites, mises, credits, journal, lectures, tx };
}

describe('annuaire : une fiche « non démarchée » ne se convertit jamais', () => {
  it('ni par la commande qui l’a fait entrer, ni par une nouvelle : seule sa dernière commande est mise à jour', async () => {
    const nouvelle = new Date(MAINTENANT - JOUR);
    const m = monter(fiche(), [
      { id: 'o-derniere', created_at: DERNIERE, amount: 7200 },
      { id: 'o-nouvelle', created_at: nouvelle, amount: 5000 },
    ]);

    await m.service.synchroniserContact('x1');

    expect(m.contact.status).toBe(CrmStatus.NON_DEMARCHE);
    expect(m.ecrites).toEqual([]);
    expect(m.credits).toEqual([]);
    expect(m.mises).toEqual([expect.objectContaining({ last_order_at: nouvelle })]);
  });
});

describe('annuaire : une fiche prise en charge ne compte que les commandes passées après la prise', () => {
  const priseEnCharge = () => fiche({ status: CrmStatus.A_APPELER, assigned_to_id: 'agent-1', segment_since: PRISE });

  it('une commande d’avant la prise est ignorée', async () => {
    const m = monter(priseEnCharge(), [{ id: 'o-avant', created_at: new Date(PRISE.getTime() - JOUR), amount: 6000 }]);
    await m.service.synchroniserContact('x1');
    expect(m.contact.status).toBe(CrmStatus.A_APPELER);
    expect(m.credits).toEqual([]);
  });

  it('une commande d’après la prise convertit, et la vente va à son agent', async () => {
    const apres = new Date(PRISE.getTime() + JOUR);
    const m = monter(priseEnCharge(), [
      { id: 'o-avant', created_at: new Date(PRISE.getTime() - JOUR), amount: 6000 },
      { id: 'o-apres', created_at: apres, amount: 8000 },
    ]);
    await m.service.synchroniserContact('x1');
    expect(m.contact).toMatchObject({ status: CrmStatus.CONVERTI, conversion_order_id: 'o-apres', converted_at: apres });
    expect(m.credits).toEqual([{ agent: 'agent-1', commande: 'o-apres' }]);
  });

  it('prise en charge AVANT la correction (date d’entrée restée sur sa dernière commande) : cette commande ne compte pas', async () => {
    const m = monter(fiche({ status: CrmStatus.A_APPELER, assigned_to_id: 'agent-1' }), [
      { id: 'o-derniere', created_at: DERNIERE, amount: 7200 },
    ]);
    await m.service.synchroniserContact('x1');
    expect(m.contact.status).toBe(CrmStatus.A_APPELER);
    expect(m.credits).toEqual([]);
  });

  it('debutVentes : une milliseconde après l’entrée pour l’annuaire, l’entrée elle-même pour les autres publics', () => {
    expect(debutVentes({ segment: CrmSegment.CLIENT, segment_since: DERNIERE }).getTime()).toBe(DERNIERE.getTime() + 1);
    expect(debutVentes({ segment: CrmSegment.INACTIF, segment_since: DERNIERE })).toBe(DERNIERE);
    expect(DEBUT_VENTES_SQL).toContain(`WHEN x."segment" = 'CLIENT' THEN interval '1 millisecond'`);
  });
});

describe('rétablissement (la commande de la conversion a disparu)', () => {
  const convertie = (surcharge: Record<string, unknown> = {}) =>
    fiche({ status: CrmStatus.CONVERTI, conversion_order_id: 'o-supprimee', converted_at: DERNIERE, ...surcharge });

  it('client de l’annuaire jamais travaillé : revient « non démarché », pas « à appeler » sans agent', async () => {
    const m = monter(convertie(), [{ id: 'o-ancienne', created_at: new Date(MAINTENANT - 40 * JOUR), amount: 5000 }]);
    await m.service.synchroniserContact('x1');
    expect(m.contact).toMatchObject({ status: CrmStatus.NON_DEMARCHE, conversion_order_id: null, converted_at: null });
    expect(m.journal.map((e) => e.label)).toEqual(["Commande supprimée : le client revient dans l'annuaire"]);
  });

  it('client de l’annuaire déjà appelé, ou qui a reçu un coupon : revient dans la liste comme avant', async () => {
    const appele = monter(convertie({ call_count: 2, last_call_outcome: CrmCallOutcome.A_RAPPELER }), []);
    await appele.service.synchroniserContact('x1');
    expect(appele.contact.status).toBe(CrmStatus.A_RAPPELER);

    const avecCoupon = monter(convertie(), [], { coupons: 1 });
    await avecCoupon.service.synchroniserContact('x1');
    expect(avecCoupon.contact.status).toBe(CrmStatus.A_APPELER);
  });

  it('un inscrit sans agent ni appel ne passe pas « non démarché » : la règle ne vaut que pour l’annuaire', async () => {
    const m = monter(convertie({ segment: CrmSegment.JAMAIS_COMMANDE }), []);
    await m.service.synchroniserContact('x1');
    expect(m.contact.status).toBe(CrmStatus.A_APPELER);
  });

  it('la campagne est relue DANS la transaction, verrouillée en partage ; terminée, la fiche la quitte', async () => {
    const m = monter(convertie({ segment: CrmSegment.INACTIF, call_count: 1, campaign_id: 'camp-1' }), [], {
      campagne: 'COMPLETED',
    });
    await m.service.synchroniserContact('x1');
    expect(m.lectures).toHaveLength(1);
    expect(m.lectures[0]).toContain('FROM "ConversionCampaign"');
    expect(m.lectures[0]).toContain('FOR SHARE');
    expect(m.ecrites[0]).toMatchObject({ status: CrmStatus.A_APPELER, campaign_id: null });
  });

  it('campagne encore en cours : la fiche y reste', async () => {
    const m = monter(convertie({ segment: CrmSegment.INACTIF, call_count: 1, campaign_id: 'camp-1' }), [], {
      campagne: 'ACTIVE',
    });
    await m.service.synchroniserContact('x1');
    expect(m.ecrites[0]).not.toHaveProperty('campaign_id');
  });

  it('sans campagne : aucune lecture verrouillée', async () => {
    const m = monter(convertie({ segment: CrmSegment.INACTIF, call_count: 1 }), []);
    await m.service.synchroniserContact('x1');
    expect(m.tx.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('réconciliation : fiches à revoir', () => {
  it('écarte les fiches « non démarchées », et ne juge l’annuaire que sur une commande postérieure à l’entrée', async () => {
    const requetes: string[] = [];
    const service = Object.create(CrmRattrapageService.prototype) as CrmRattrapageService;
    Object.assign(service, {
      prisma: {
        $executeRawUnsafe: jest.fn(async () => 0),
        $queryRawUnsafe: jest.fn(async (sql: string) => (requetes.push(sql), [])),
      },
      config: { joursInactivite: async () => 30 },
      registre: { bascule: async () => null },
      sync: { synchroniserContact: jest.fn() },
      logger: { warn: jest.fn() },
    });
    await service.reconcilier();
    const aRevoir = requetes.find((s) => s.includes('LIMIT 500'))!;
    expect(aRevoir).toContain(`x."status" NOT IN ('CONVERTI', 'NON_DEMARCHE')`);
    expect(aRevoir).toContain(`o."created_at" >= ${DEBUT_VENTES_SQL}`);
  });
});
