/**
 * Repères du journal d'audit (28/11) : quelles cibles relire, quoi écrire,
 * comment chercher. Règles : audit-reperes.rules.ts.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { LETTRES_ACCENTUEES, LETTRES_NUES } from 'src/modules/order/helpers/recherche-commande.rules';
import {
  CIBLES_MAX,
  assemblerReperes,
  ciblesDeLEntree,
  ciblesDeLaReponse,
  ciblesDuChemin,
  ciblesDuContenu,
  ciblesRetenues,
  conditionRechercheAudit,
  ficheDuCompte,
  ficheDuCorps,
  sansReperes,
  texteNu,
} from './audit-reperes.rules';

const ID = 'a4559e28-1111-4111-8111-111111111111';
const ID2 = 'c8a3e1f8-2222-4222-8222-222222222222';
const texte = (v: unknown) => JSON.stringify(v);

describe('ciblesDuChemin', () => {
  it('une commande, par toutes ses routes', () => {
    expect(ciblesDuChemin(`/api/v1/orders/${ID}/status`)).toEqual([{ type: 'order', id: ID }]);
    expect(ciblesDuChemin(`/api/v1/orders/relances/${ID}/prendre`)).toEqual([{ type: 'order', id: ID }]);
    expect(ciblesDuChemin(`/api/v1/courses/commandes/${ID}/affecter?x=1`)).toEqual([{ type: 'order', id: ID }]);
  });

  it('livraison, course, paiement, incident', () => {
    expect(ciblesDuChemin(`/api/v1/courses/deliveries/${ID}/confirm`)).toEqual([{ type: 'delivery', id: ID }]);
    expect(ciblesDuChemin(`/api/v1/courses/${ID}/livreur`)).toEqual([{ type: 'course', id: ID }]);
    expect(ciblesDuChemin(`/api/v1/paiements/${ID}`)).toEqual([{ type: 'paiement', id: ID }]);
    expect(ciblesDuChemin(`/api/v1/incidents/${ID}/resoudre`)).toEqual([{ type: 'incident', id: ID }]);
  });

  it('les personnes : client, fiche du CRM, livreur, membre du personnel', () => {
    expect(ciblesDuChemin(`/api/v1/customer/${ID}`)).toEqual([{ type: 'customer', id: ID }]);
    // Segment inconnu avant l'identifiant : le module décide.
    expect(ciblesDuChemin(`/api/v1/customer/admin/${ID}`)).toEqual([{ type: 'customer', id: ID }]);
    expect(ciblesDuChemin(`/api/v1/crm/contacts/${ID}/calls`)).toEqual([{ type: 'crmContact', id: ID }]);
    expect(ciblesDuChemin(`/api/v1/deliverers/${ID}/suspend`)).toEqual([{ type: 'deliverer', id: ID }]);
    expect(ciblesDuChemin(`/api/v1/users/${ID}`)).toEqual([{ type: 'user', id: ID }]);
  });

  it('rien à relire pour le reste : un plat, une campagne, une route sans identifiant', () => {
    expect(ciblesDuChemin(`/api/v1/dishes/${ID}`)).toEqual([]);
    expect(ciblesDuChemin(`/api/v1/crm/${ID}/launch`)).toEqual([]);
    expect(ciblesDuChemin('/api/v1/orders')).toEqual([]);
    expect(ciblesDuChemin(undefined)).toEqual([]);
  });
});

describe('ciblesDuContenu', () => {
  it('lit les clés qui désignent une commande, un client, un livreur', () => {
    expect(ciblesDuContenu({ order_id: ID, customerId: ID2, deliverer_id: ID, note: 'x' })).toEqual([
      { type: 'order', id: ID },
      { type: 'customer', id: ID2 },
      { type: 'deliverer', id: ID },
    ]);
  });

  it('référence de commande d’un événement de paiement', () => {
    expect(ciblesDuContenu({ reference_commande: 'ORD-261128-00042', montant: 5040 })).toEqual([
      { type: 'order', reference: 'ORD-261128-00042' },
    ]);
  });

  it('ignore ce qui n’est pas un identifiant', () => {
    expect(ciblesDuContenu({ order_id: '12', customer_id: null })).toEqual([]);
    expect(ciblesDuContenu('texte')).toEqual([]);
    expect(ciblesDuContenu([{ order_id: ID }])).toEqual([]);
  });
});

describe('ciblesDeLaReponse', () => {
  it('création : la commande renvoyée devient la cible', () => {
    expect(ciblesDeLaReponse('POST', '/api/v1/orders', { id: ID, reference: 'ORD-1' })).toEqual([
      { type: 'order', id: ID },
    ]);
    expect(ciblesDeLaReponse('POST', '/api/v1/orders/create', { data: { id: ID } })).toEqual([
      { type: 'order', id: ID },
    ]);
    expect(ciblesDeLaReponse('POST', '/api/v1/users', { id: ID })).toEqual([{ type: 'user', id: ID }]);
  });

  it('le chemin porte déjà la cible : l’identifiant de la réponse n’est pas relu', () => {
    expect(ciblesDeLaReponse('POST', `/api/v1/crm/contacts/${ID}/calls`, { id: ID2 })).toEqual([]);
    expect(ciblesDeLaReponse('PATCH', '/api/v1/orders', { id: ID })).toEqual([]);
  });

  it('les clés de la réponse comptent aussi : un appel du CRM qui crée une commande', () => {
    expect(ciblesDeLaReponse('POST', `/api/v1/crm/contacts/${ID}/calls`, { id: ID2, order_id: ID2 })).toEqual([
      { type: 'order', id: ID2 },
    ]);
  });

  it('module sans cible connue, réponse vide', () => {
    expect(ciblesDeLaReponse('POST', '/api/v1/dishes', { id: ID })).toEqual([]);
    expect(ciblesDeLaReponse('POST', '/api/v1/orders', undefined)).toEqual([]);
  });
});

describe('ciblesDeLEntree : ligne écrite par un module, sans requête', () => {
  it('commande désignée par le module et la cible, client par le détail', () => {
    expect(
      ciblesDeLEntree({ module: 'orders', entity_id: ID, path: '/orders/create', metadata: { customer_id: ID2 } }),
    ).toEqual([
      { type: 'order', id: ID },
      { type: 'customer', id: ID2 },
    ]);
  });

  it('paiement KKiaPay : la cible est une transaction, la commande vient de sa référence', () => {
    expect(
      ciblesDeLEntree({
        module: 'paiements',
        entity_id: 'tx_123',
        path: '/kkiapay/webhook',
        metadata: { reference_commande: 'ORD-261128-00042' },
      }),
    ).toEqual([{ type: 'order', reference: 'ORD-261128-00042' }]);
  });
});

describe('ciblesRetenues', () => {
  it('sans doublon, dans l’ordre', () => {
    expect(
      ciblesRetenues([
        { type: 'order', id: ID },
        { type: 'order', id: ID },
        { type: 'customer', id: ID2 },
        { type: 'order' },
      ]),
    ).toEqual([
      { type: 'order', id: ID },
      { type: 'customer', id: ID2 },
    ]);
  });

  it(`au plus ${CIBLES_MAX} lectures par ligne`, () => {
    const beaucoup = Array.from({ length: 10 }, (_, i) => ({ type: 'order' as const, reference: `ORD-${i}` }));
    expect(ciblesRetenues(beaucoup)).toHaveLength(CIBLES_MAX);
  });
});

describe('ce qui se lit sans la base', () => {
  it('corps : numéro, nom et adresse saisis', () => {
    expect(ficheDuCorps({ fullname: 'Awa Koné', phone: '+2250707070707', items: [] })).toEqual({
      ref: null,
      nom: 'Awa Koné',
      telephone: '+2250707070707',
      autres: [null],
    });
    expect(ficheDuCorps({ first_name: 'Awa', last_name: 'Koné' })?.nom).toBe('Awa Koné');
    // Connexion refusée : l'adresse saisie se cherche.
    expect(ficheDuCorps({ email: 'caisse@exemple.ci', password: 'secret' })).toEqual({
      ref: null,
      nom: null,
      telephone: null,
      autres: ['caisse@exemple.ci'],
    });
  });

  it('corps : rien d’utile, rien de masqué, jamais de mot de passe', () => {
    expect(ficheDuCorps({ status: 'READY' })).toBeNull();
    expect(ficheDuCorps({ phone: '***' })).toBeNull();
    expect(ficheDuCorps(undefined)).toBeNull();
    expect(texte(ficheDuCorps({ email: 'a@b.ci', password: 'secret', token: 'jeton' }))).not.toMatch(/secret|jeton/);
  });

  it('compte : un client ou un livreur, jamais le personnel (c’est l’auteur)', () => {
    expect(ficheDuCompte({ id: 'c1', first_name: 'Awa', last_name: 'Koné', phone: '+2250707070707' })).toEqual({
      nom: 'Awa Koné',
      telephone: '+2250707070707',
      autres: [null],
    });
    expect(ficheDuCompte({ id: 'u1', fullname: 'Agent Yao', role: 'CALL_CENTER', phone: '0101' })).toBeNull();
    expect(ficheDuCompte(undefined)).toBeNull();
  });
});

describe('assemblerReperes', () => {
  it('commande : référence, client, numéro ; tout se cherche en minuscules sans accents', () => {
    const reperes = assemblerReperes([
      {
        ref: 'ORD-261128-00042',
        nom: 'Awa Mariam Koné',
        telephone: '+2250707070707',
        autres: ['Mariam K.', '07 07 07 07 07', '+2250707070707', 'mariam@exemple.ci'],
      },
    ]);
    expect(reperes).toEqual({
      target_ref: 'ORD-261128-00042',
      target_name: 'Awa Mariam Koné',
      target_phone: '+2250707070707',
      search_text: 'ord-261128-00042 awa mariam kone 2250707070707 mariam k. 0707070707 mariam@exemple.ci',
    });
  });

  it('plusieurs fiches : la première référence, le premier nom, le premier numéro s’affichent', () => {
    const reperes = assemblerReperes([
      { ref: 'CRS-1', nom: null, telephone: null },
      null,
      { ref: 'LIV-9', nom: 'Koffi Yao', telephone: '0700000009' },
    ]);
    expect(reperes).toEqual(
      expect.objectContaining({ target_ref: 'CRS-1', target_name: 'Koffi Yao', target_phone: '0700000009' }),
    );
    expect(reperes?.search_text).toBe('crs-1 liv-9 koffi yao 0700000009');
  });

  it('sans doublon dans le texte cherché, rien quand il n’y a rien', () => {
    expect(assemblerReperes([{ nom: 'Awa', autres: ['awa', 'AWA'] }])?.search_text).toBe('awa');
    expect(assemblerReperes([])).toBeNull();
    expect(assemblerReperes([{ ref: ' ', nom: null, autres: [null, ''] }])).toBeNull();
  });

  it('borne les champs', () => {
    const reperes = assemblerReperes([{ nom: 'x'.repeat(500), autres: Array.from({ length: 50 }, (_, i) => `mot${i}`.repeat(10)) }]);
    expect(reperes?.target_name).toHaveLength(120);
    expect(reperes?.search_text?.length).toBeLessThanOrEqual(600);
  });
});

describe('conditionRechercheAudit', () => {
  it('rien de saisi : aucune condition', () => {
    expect(conditionRechercheAudit('')).toBeNull();
    expect(conditionRechercheAudit('   ')).toBeNull();
    expect(conditionRechercheAudit(undefined)).toBeNull();
  });

  it('comme avant : auteur, chemin, résumé, identifiant de la cible', () => {
    const condition = conditionRechercheAudit('Agent');
    expect(condition?.OR).toEqual(
      expect.arrayContaining([
        { actor_name: { contains: 'Agent', mode: 'insensitive' } },
        { path: { contains: 'Agent', mode: 'insensitive' } },
        { summary: { contains: 'Agent', mode: 'insensitive' } },
        { entity_id: { contains: 'Agent', mode: 'insensitive' } },
      ]),
    );
  });

  it('une référence de commande se cherche dans les repères', () => {
    const condition = conditionRechercheAudit('ORD-261128-00042');
    expect(condition?.OR).toEqual(
      expect.arrayContaining([{ AND: [{ search_text: { contains: 'ord-261128-00042' } }] }]),
    );
  });

  it('l’identifiant court affiché à l’écran, avec son « # »', () => {
    expect(conditionRechercheAudit('#a4559e28')?.OR).toEqual(
      expect.arrayContaining([{ entity_id: { contains: 'a4559e28', mode: 'insensitive' } }]),
    );
  });

  it('un nom : tous les mots, accents ignorés, quatre mots au plus', () => {
    expect(conditionRechercheAudit('Koné  MARIAM')?.OR).toEqual(
      expect.arrayContaining([
        { AND: [{ search_text: { contains: 'kone' } }, { search_text: { contains: 'mariam' } }] },
      ]),
    );
    const longue = conditionRechercheAudit('a b c d e f')?.OR?.find((c) => 'AND' in c) as { AND: unknown[] };
    expect(longue.AND).toHaveLength(4);
  });

  it('un numéro, sous toutes ses écritures : ses dix chiffres', () => {
    for (const saisie of ['0707070707', '07 07 07 07 07', '+225 07 07 07 07 07', '002250707070707']) {
      expect(texte(conditionRechercheAudit(saisie))).toContain('{"search_text":{"contains":"0707070707"}}');
    }
    // Une partie de numéro aussi, comme les chiffres d'une référence.
    expect(texte(conditionRechercheAudit('7070'))).toContain('{"search_text":{"contains":"7070"}}');
  });

  it('un numéro n’est jamais cherché mot à mot', () => {
    // « 07 », « 07 »… pris un à un ramèneraient presque tout le journal.
    const condition = texte(conditionRechercheAudit('07 07 07 07 07'));
    expect(condition).not.toContain('"AND"');
    expect(condition).not.toContain('{"search_text":{"contains":"07"}}');
    expect(texte(conditionRechercheAudit('+225 0707070707'))).not.toContain('+225"}}');
  });
});

describe('sansReperes', () => {
  it('retours privés « Ton avis compte » : aucun repère', () => {
    expect(sansReperes(`/api/v1/avis-prives/${ID}/journal`)).toBe(true);
    expect(sansReperes('/api/v1/avis-prives')).toBe(true);
    expect(sansReperes(`/api/v1/orders/${ID}`)).toBe(false);
    expect(sansReperes(null)).toBe(false);
  });
});

describe('reprise des lignes déjà écrites (migration)', () => {
  const sql = readFileSync(
    join(__dirname, '../../../prisma/migrations/20261128120000_audit_reperes/migration.sql'),
    'utf8',
  );

  it('range le texte cherché comme le serveur : minuscules, mêmes lettres sans accent', () => {
    expect(sql).toContain(`'${LETTRES_ACCENTUEES}', '${LETTRES_NUES}'`);
    // Chaque lettre de la liste est bien ramenée à sa lettre nue par le serveur.
    expect(texteNu(LETTRES_ACCENTUEES)).toBe(LETTRES_NUES);
  });

  it('ne touche que les lignes sans repère, jamais les retours privés', () => {
    const reprises = sql.split(/\nUPDATE "audit_logs" a\n/).slice(1);
    expect(reprises).toHaveLength(9);
    for (const reprise of reprises) {
      expect(reprise).toContain('WHERE a."search_text" IS NULL');
      expect(reprise).toContain(`a."path" NOT LIKE '%/avis-prives%'`);
    }
  });
});
