import { CampaignStatus as C, CrmSegment as P, CrmStatus as S, EntityStatus as E } from '@prisma/client';
import {
  bacsApercu,
  critereCampagne,
  criteresEnClair,
  memesCriteres,
  populationCampagne,
  PublicCampagne,
  publicsDepuisAncienCorps,
  sortieFinCampagne,
  verifierPublics,
} from './crm-campagne.rules';

/**
 * Évaluateur minimal des filtres Prisma employés par les règles : il applique
 * le filtre à une fiche en mémoire, comme le ferait la base. Les tests
 * vérifient ainsi QUI est ciblé, et non la forme du filtre.
 */
type Fiche = Record<string, unknown>;

function correspond(obj: Fiche, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([cle, cond]) => {
    if (cle === 'AND') return (cond as Record<string, unknown>[]).every((w) => correspond(obj, w));
    if (cle === 'OR') return (cond as Record<string, unknown>[]).some((w) => correspond(obj, w));
    return champ(obj[cle], cond);
  });
}

const OPERATEURS = ['in', 'notIn', 'not', 'gte', 'lt', 'gt', 'lte'];
const valeurDe = (v: unknown) => (v instanceof Date ? v.getTime() : v);

function champ(valeur: unknown, cond: unknown): boolean {
  if (cond === null || typeof cond !== 'object' || cond instanceof Date) return valeurDe(valeur) === valeurDe(cond);
  const c = cond as Record<string, unknown>;
  if ('some' in c) return ((valeur as Fiche[]) ?? []).some((e) => correspond(e, c.some as Record<string, unknown>));
  if (Object.keys(c).every((k) => OPERATEURS.includes(k))) {
    return Object.entries(c).every(([op, v]) => {
      const a = valeurDe(valeur) as number;
      const b = valeurDe(v) as number;
      switch (op) {
        case 'in':
          return (v as unknown[]).includes(valeur);
        case 'notIn':
          return valeur != null && !(v as unknown[]).includes(valeur);
        case 'not':
          return v === null ? valeur != null : valeur != null && a !== b;
        case 'gte':
          return valeur != null && a >= b;
        case 'gt':
          return valeur != null && a > b;
        case 'lt':
          return valeur != null && a < b;
        case 'lte':
          return valeur != null && a <= b;
      }
      return false;
    });
  }
  // Relation vers une seule ligne : une relation absente ne correspond jamais.
  return valeur != null && correspond(valeur as Fiche, c);
}

const MAINTENANT = new Date('2026-09-24T10:00:00.000Z');
const EQUIPE = ['agent-equipe'];

const fiche = (p: Partial<Fiche> = {}): Fiche => ({
  segment: P.JAMAIS_COMMANDE,
  status: S.A_APPELER,
  entity_status: E.ACTIVE,
  registered_at: new Date('2026-09-10T08:00:00.000Z'),
  segment_since: new Date('2026-09-10T08:00:00.000Z'),
  cycle: 1,
  customer_id: 'client-1',
  campaign_id: null,
  campaign: null,
  assigned_to_id: null,
  assigned_to: null,
  captures: [],
  ...p,
});

const capture = (p: Partial<Fiche> = {}): Fiche => ({
  platform: 'GLOVO',
  entity_status: E.ACTIVE,
  restaurant_id: 'resto-x',
  created_at: new Date('2026-09-10T12:00:00.000Z'),
  ...p,
});

const cible = (pub: PublicCampagne, f: Fiche, equipe = EQUIPE) =>
  correspond(f, critereCampagne(pub, equipe, MAINTENANT) as Record<string, unknown>);

describe('critereCampagne : base commune', () => {
  const pub: PublicCampagne = { segment: P.JAMAIS_COMMANDE };

  it('prend les statuts ouverts, jamais les pas intéressés, injoignables ou convertis', () => {
    for (const s of [S.A_APPELER, S.A_RAPPELER, S.INTERESSE, S.COUPON_ENVOYE]) expect(cible(pub, fiche({ status: s }))).toBe(true);
    for (const s of [S.NON_INTERESSE, S.INJOIGNABLE, S.CONVERTI]) expect(cible(pub, fiche({ status: s }))).toBe(false);
  });

  it("n'accepte que le public visé et les fiches non supprimées", () => {
    expect(cible(pub, fiche({ segment: P.INACTIF }))).toBe(false);
    expect(cible(pub, fiche({ entity_status: E.DELETED }))).toBe(false);
  });

  it('écarte un contact déjà dans une campagne en cours, reprend celui d’une campagne close', () => {
    expect(cible(pub, fiche({ campaign_id: 'c1', campaign: { status: C.ACTIVE } }))).toBe(false);
    expect(cible(pub, fiche({ campaign_id: 'c1', campaign: { status: C.SUSPENDED } }))).toBe(false);
    expect(cible(pub, fiche({ campaign_id: 'c1', campaign: { status: C.COMPLETED } }))).toBe(true);
  });

  it("laisse à un agent actif hors équipe son contact, reprend celui d'un agent désactivé", () => {
    expect(cible(pub, fiche({ assigned_to_id: 'agent-equipe', assigned_to: { entity_status: E.ACTIVE } }))).toBe(true);
    expect(cible(pub, fiche({ assigned_to_id: 'dehors', assigned_to: { entity_status: E.ACTIVE } }))).toBe(false);
    expect(cible(pub, fiche({ assigned_to_id: 'dehors', assigned_to: { entity_status: E.INACTIVE } }))).toBe(true);
    expect(cible(pub, fiche({ assigned_to_id: 'dehors', assigned_to: { entity_status: E.DELETED } }))).toBe(true);
  });

  it('sans équipe, tout contact suivi par un agent actif est écarté', () => {
    expect(cible(pub, fiche({ assigned_to_id: 'agent-equipe', assigned_to: { entity_status: E.ACTIVE } }), [])).toBe(false);
    expect(cible(pub, fiche(), [])).toBe(true);
  });
});

describe('critereCampagne : période propre à chaque public', () => {
  it("inscrits : la période porte sur l'inscription, bornes [du ; au + 1 jour[", () => {
    const pub: PublicCampagne = { segment: P.JAMAIS_COMMANDE, period_from: '2026-09-01', period_to: '2026-09-10' };
    expect(cible(pub, fiche({ registered_at: new Date('2026-09-01T00:00:00.000Z') }))).toBe(true);
    expect(cible(pub, fiche({ registered_at: new Date('2026-09-10T23:59:59.000Z') }))).toBe(true);
    expect(cible(pub, fiche({ registered_at: new Date('2026-09-11T00:00:00.000Z') }))).toBe(false);
    expect(cible(pub, fiche({ registered_at: new Date('2026-08-31T23:59:59.000Z') }))).toBe(false);
    // L'entrée dans le public ne compte pas pour les inscrits.
    expect(cible(pub, fiche({ registered_at: new Date('2026-08-01T00:00:00.000Z'), segment_since: new Date('2026-09-05T00:00:00.000Z') }))).toBe(false);
  });

  it("inactifs : la période porte sur l'entrée en inactivité, pas sur l'inscription", () => {
    const pub: PublicCampagne = { segment: P.INACTIF, period_from: '2026-09-01', period_to: '2026-09-10' };
    const base = { segment: P.INACTIF, registered_at: new Date('2025-01-01T00:00:00.000Z') };
    expect(cible(pub, fiche({ ...base, segment_since: new Date('2026-09-05T00:00:00.000Z') }))).toBe(true);
    expect(cible(pub, fiche({ ...base, segment_since: new Date('2026-08-05T00:00:00.000Z') }))).toBe(false);
  });

  it('inactifs « déjà reconquis une fois » : cycle 2 et plus', () => {
    const pub: PublicCampagne = { segment: P.INACTIF, relapsed_only: true };
    expect(cible(pub, fiche({ segment: P.INACTIF, cycle: 1 }))).toBe(false);
    expect(cible(pub, fiche({ segment: P.INACTIF, cycle: 2 }))).toBe(true);
    expect(cible({ segment: P.INACTIF }, fiche({ segment: P.INACTIF, cycle: 1 }))).toBe(true);
  });
});

describe('critereCampagne : Glovo et Yango', () => {
  const glovo = (p: Partial<Fiche> = {}) =>
    fiche({ segment: P.GLOVO, registered_at: null, customer_id: null, segment_since: new Date('2026-09-10T12:00:00.000Z'), captures: [capture()], ...p });

  it("J+1 : un client capté aujourd'hui n'entre qu'à partir de demain", () => {
    const pub: PublicCampagne = { segment: P.GLOVO };
    expect(cible(pub, glovo({ segment_since: new Date('2026-09-23T23:59:00.000Z') }))).toBe(true);
    expect(cible(pub, glovo({ segment_since: new Date('2026-09-24T00:00:00.000Z') }))).toBe(false);
  });

  it("une période n'écarte plus les fiches sans compte : elle porte sur la capture", () => {
    const pub: PublicCampagne = { segment: P.GLOVO, period_from: '2026-09-01', period_to: '2026-09-15' };
    expect(cible(pub, glovo())).toBe(true);
    expect(cible(pub, glovo({ captures: [capture({ created_at: new Date('2026-08-20T00:00:00.000Z') })] }))).toBe(false);
  });

  it('restaurant et période portent sur une MÊME capture de la plateforme', () => {
    const pub: PublicCampagne = { segment: P.GLOVO, period_from: '2026-09-01', period_to: '2026-09-15', restaurant_ids: ['resto-x'] };
    // Une capture au bon restaurant mais hors période, une autre dans la période ailleurs : non.
    const croisee = glovo({
      captures: [
        capture({ restaurant_id: 'resto-x', created_at: new Date('2026-08-01T00:00:00.000Z') }),
        capture({ restaurant_id: 'resto-y', created_at: new Date('2026-09-05T00:00:00.000Z') }),
      ],
    });
    expect(cible(pub, croisee)).toBe(false);
    expect(cible(pub, glovo({ captures: [capture({ restaurant_id: 'resto-x', created_at: new Date('2026-09-05T00:00:00.000Z') })] }))).toBe(true);
    // Une capture Yango du bon restaurant ne fait pas un client Glovo de ce restaurant.
    expect(cible(pub, glovo({ captures: [capture({ platform: 'YANGO', created_at: new Date('2026-09-05T00:00:00.000Z') })] }))).toBe(false);
    // Une capture supprimée ne compte pas.
    expect(cible(pub, glovo({ captures: [capture({ entity_status: E.DELETED })] }))).toBe(false);
  });

  it('avec ou sans compte sur l’appli', () => {
    expect(cible({ segment: P.GLOVO, account: 'SANS' }, glovo())).toBe(true);
    expect(cible({ segment: P.GLOVO, account: 'AVEC' }, glovo())).toBe(false);
    expect(cible({ segment: P.GLOVO, account: 'AVEC' }, glovo({ customer_id: 'client-9' }))).toBe(true);
    expect(cible({ segment: P.GLOVO }, glovo({ customer_id: 'client-9' }))).toBe(true);
  });

  it('les exclusions communes valent aussi pour Glovo/Yango', () => {
    const pub: PublicCampagne = { segment: P.YANGO };
    const yango = glovo({ segment: P.YANGO, captures: [capture({ platform: 'YANGO' })] });
    expect(cible(pub, yango)).toBe(true);
    expect(cible(pub, { ...yango, status: S.NON_INTERESSE })).toBe(false);
    expect(cible(pub, { ...yango, status: S.INJOIGNABLE })).toBe(false);
    expect(cible(pub, { ...yango, assigned_to_id: 'dehors', assigned_to: { entity_status: E.ACTIVE } })).toBe(false);
    expect(cible(pub, { ...yango, assigned_to_id: 'dehors', assigned_to: { entity_status: E.INACTIVE } })).toBe(true);
  });
});

describe('populationCampagne', () => {
  it('réunit les publics, chacun avec ses critères', () => {
    const publics: PublicCampagne[] = [
      { segment: P.JAMAIS_COMMANDE, period_from: '2026-09-01' },
      { segment: P.GLOVO, account: 'SANS' },
    ];
    const w = populationCampagne(publics, EQUIPE, MAINTENANT) as Record<string, unknown>;
    expect(correspond(fiche(), w)).toBe(true);
    expect(correspond(fiche({ registered_at: new Date('2026-08-01T00:00:00.000Z') }), w)).toBe(false);
    expect(correspond(fiche({ segment: P.GLOVO, customer_id: null }), w)).toBe(true);
    expect(correspond(fiche({ segment: P.GLOVO, customer_id: 'c' }), w)).toBe(false);
    expect(correspond(fiche({ segment: P.INACTIF }), w)).toBe(false);
  });
});

describe('bacsApercu', () => {
  const pub: PublicCampagne = { segment: P.GLOVO };
  const bacs = bacsApercu(pub, EQUIPE, MAINTENANT);
  const hier = new Date('2026-09-23T10:00:00.000Z');
  const auj = new Date('2026-09-24T08:00:00.000Z');
  const cas: [string, Fiche][] = [
    ['disponible', fiche({ segment: P.GLOVO, segment_since: hier })],
    ['autre_campagne', fiche({ segment: P.GLOVO, segment_since: hier, campaign_id: 'c', campaign: { status: C.ACTIVE } })],
    ['agent_hors_equipe', fiche({ segment: P.GLOVO, segment_since: hier, assigned_to_id: 'dehors', assigned_to: { entity_status: E.ACTIVE } })],
    ['captes_aujourdhui', fiche({ segment: P.GLOVO, segment_since: auj })],
    ['non_interesses', fiche({ segment: P.GLOVO, segment_since: hier, status: S.NON_INTERESSE })],
    ['injoignables', fiche({ segment: P.GLOVO, segment_since: auj, status: S.INJOIGNABLE, campaign_id: 'c', campaign: { status: C.ACTIVE } })],
    ['aucun', fiche({ segment: P.GLOVO, segment_since: hier, status: S.CONVERTI })],
  ];

  it.each(cas)('classe chaque contact dans un seul bac (%s)', (attendu, f) => {
    const dispo = cible(pub, f);
    const dans = Object.entries(bacs)
      .filter(([, w]) => w && correspond(f, w as Record<string, unknown>))
      .map(([nom]) => nom);
    if (attendu === 'disponible') {
      expect(dispo).toBe(true);
      expect(dans).toEqual([]);
    } else if (attendu === 'aucun') {
      expect(dispo).toBe(false);
      expect(dans).toEqual([]);
    } else {
      expect(dispo).toBe(false);
      expect(dans).toEqual([attendu]);
    }
  });

  it("pas de bac « captés aujourd'hui » hors Glovo/Yango", () => {
    expect(bacsApercu({ segment: P.INACTIF }, EQUIPE, MAINTENANT).captes_aujourdhui).toBeNull();
  });
});

describe('sortieFinCampagne', () => {
  const apres = new Date('2026-09-25T09:00:00.000Z');
  const avant = new Date('2026-09-23T09:00:00.000Z');
  const sortie = (status: S, callback_at: Date | null = null, coupon = false) => sortieFinCampagne({ status, callback_at }, coupon, MAINTENANT);

  it('un intéressé reste à son agent', () => {
    expect(sortie(S.INTERESSE)).toBe('GARDER_AGENT');
    expect(sortie(S.INTERESSE, null, true)).toBe('GARDER_AGENT');
  });

  it('un coupon envoyé reste à son agent tant que le coupon est valable', () => {
    expect(sortie(S.COUPON_ENVOYE, null, true)).toBe('GARDER_AGENT');
    expect(sortie(S.COUPON_ENVOYE, null, false)).toBe('LIBERER');
  });

  it('un rappel daté à venir reste à son agent, un rappel passé ou sans date est libéré', () => {
    expect(sortie(S.A_RAPPELER, apres)).toBe('GARDER_AGENT');
    expect(sortie(S.A_RAPPELER, MAINTENANT)).toBe('GARDER_AGENT');
    expect(sortie(S.A_RAPPELER, avant)).toBe('LIBERER');
    expect(sortie(S.A_RAPPELER, null)).toBe('LIBERER');
  });

  it('tous les autres statuts sont libérés, rappel ou coupon compris', () => {
    for (const s of [S.A_APPELER, S.NON_INTERESSE, S.INJOIGNABLE, S.CONVERTI]) {
      expect(sortie(s)).toBe('LIBERER');
      expect(sortie(s, apres, true)).toBe('LIBERER');
    }
  });
});

describe('verifierPublics', () => {
  it('accepte des publics cohérents', () => {
    expect(
      verifierPublics([
        { segment: P.JAMAIS_COMMANDE, period_from: '2026-09-01', period_to: '2026-09-01' },
        { segment: P.INACTIF, relapsed_only: true },
        { segment: P.GLOVO, restaurant_ids: ['r'], account: 'SANS' },
        { segment: P.YANGO, account: 'AVEC' },
      ]),
    ).toEqual([]);
  });

  it('refuse une liste vide', () => {
    expect(verifierPublics([])).toEqual(['Choisissez au moins un public']);
  });

  it('refuse un public choisi deux fois', () => {
    expect(verifierPublics([{ segment: P.GLOVO }, { segment: P.GLOVO }])[0]).toContain('choisi deux fois');
  });

  it('refuse une période inversée', () => {
    expect(verifierPublics([{ segment: P.INACTIF, period_from: '2026-09-10', period_to: '2026-09-01' }])[0]).toContain('inversée');
  });

  it('refuse restaurants et compte hors Glovo/Yango, « déjà reconquis » hors inactifs', () => {
    expect(verifierPublics([{ segment: P.JAMAIS_COMMANDE, restaurant_ids: ['r'] }])[0]).toContain('Glovo et Yango');
    expect(verifierPublics([{ segment: P.INACTIF, account: 'AVEC' }])[0]).toContain('Glovo et Yango');
    expect(verifierPublics([{ segment: P.GLOVO, relapsed_only: true }])[0]).toContain('inactifs');
  });

  it('écrit ses messages sans tiret long', () => {
    const tous = verifierPublics([
      { segment: P.GLOVO },
      { segment: P.GLOVO, relapsed_only: true, period_from: '2026-09-10', period_to: '2026-09-01' },
      { segment: P.INACTIF, account: 'SANS' },
    ]).join(' ');
    expect(tous).not.toMatch(/[\u2013\u2014]/);
  });
});

describe('memesCriteres', () => {
  it("ignore l'ordre des restaurants et la forme des dates", () => {
    expect(
      memesCriteres(
        { segment: P.GLOVO, restaurant_ids: ['a', 'b'], period_from: new Date('2026-09-01T00:00:00.000Z') },
        { segment: P.GLOVO, restaurant_ids: ['b', 'a'], period_from: '2026-09-01' },
      ),
    ).toBe(true);
  });

  it('voit un critère changé', () => {
    expect(memesCriteres({ segment: P.GLOVO, account: 'AVEC' }, { segment: P.GLOVO })).toBe(false);
    expect(memesCriteres({ segment: P.INACTIF, relapsed_only: true }, { segment: P.INACTIF, relapsed_only: false })).toBe(false);
    expect(memesCriteres({ segment: P.INACTIF, period_to: '2026-09-02' }, { segment: P.INACTIF, period_to: '2026-09-03' })).toBe(false);
  });
});

describe('publicsDepuisAncienCorps', () => {
  it("recopie la période d'inscription sur les seuls inscrits", () => {
    expect(publicsDepuisAncienCorps([P.JAMAIS_COMMANDE, P.INACTIF], '2026-09-01', '2026-09-10')).toEqual([
      { segment: P.JAMAIS_COMMANDE, period_from: '2026-09-01', period_to: '2026-09-10' },
      { segment: P.INACTIF },
    ]);
  });

  it('vise les inscrits sans commande par défaut', () => {
    expect(publicsDepuisAncienCorps(undefined)).toEqual([{ segment: P.JAMAIS_COMMANDE, period_from: null, period_to: null }]);
  });
});

describe('criteresEnClair', () => {
  it('écrit la période selon le public, les restaurants et le compte', () => {
    const noms = new Map([['r1', 'Angré'], ['r2', 'Cocody']]);
    expect(
      criteresEnClair({ segment: P.GLOVO, period_from: '2026-09-01', period_to: '2026-09-15', restaurant_ids: ['r1', 'r2'], account: 'SANS' }, noms),
    ).toBe("Captés sur Glovo du 01/09/2026 au 15/09/2026 ; restaurants de capture : Angré, Cocody ; sans compte sur l'appli");
    expect(criteresEnClair({ segment: P.INACTIF, relapsed_only: true })).toBe('Devenus inactifs, toutes dates ; déjà reconquis une fois');
    expect(criteresEnClair({ segment: P.JAMAIS_COMMANDE, period_from: '2026-09-01' })).toBe('Inscrits depuis le 01/09/2026');
  });
});
