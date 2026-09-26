import { CORPS_MESSAGE_SUPPRIME } from 'src/common/constantes/message-supprime';
import {
  CitationBrute,
  couperAuMot,
  couperSansCasser,
  LONGUEUR_EXTRAIT_CITATION,
  resumerCitation,
  versionClient,
} from './citation';

const date = new Date('2026-09-26T18:26:00Z');

const base = (surcharge: Partial<CitationBrute> = {}): CitationBrute => ({
  id: 'm1',
  body: 'Bonjour',
  meta: { imageUrl: null, orderId: null, audioUrl: null, audioDurationMs: null },
  deletedAt: null,
  createdAt: date,
  broadcastId: null,
  authorUser: null,
  authorCustomer: null,
  ...surcharge,
});

const agent = { id: 'u1', fullname: 'Awa Koné' };
const client = { id: 'c1', first_name: 'Yao', last_name: 'Kouassi' };

describe('resumerCitation', () => {
  it('rien à citer : null', () => {
    expect(resumerCitation(null)).toBeNull();
    expect(resumerCitation(undefined)).toBeNull();
  });

  it("texte d'un agent : extrait aux blancs réduits et nom complet", () => {
    const c = resumerCitation(base({ body: '  Le livreur\n\n arrive   bientôt ', authorUser: agent }));
    expect(c).toEqual({
      id: 'm1',
      deleted: false,
      kind: 'text',
      excerpt: 'Le livreur arrive bientôt',
      author: { kind: 'user', id: 'u1', name: 'Awa Koné' },
      createdAt: date,
    });
  });

  it('texte long : 160 caractères au plus, coupé au mot, avec points de suspension', () => {
    const mot = 'poulet ';
    const long = mot.repeat(40); // 280 caractères
    const c = resumerCitation(base({ body: long, authorUser: agent }))!;
    expect(c.excerpt.length).toBeLessThanOrEqual(LONGUEUR_EXTRAIT_CITATION);
    expect(c.excerpt.endsWith('…')).toBe(true);
    // Coupé entre deux mots, jamais au milieu de « poulet ».
    expect(c.excerpt.slice(0, -1).endsWith('poulet')).toBe(true);
  });

  it('un seul mot très long est tranché plutôt que vidé', () => {
    const lien = 'https://exemple.ci/' + 'a'.repeat(300);
    const coupe = couperAuMot(lien, 160);
    expect(coupe.length).toBe(160);
    expect(coupe.endsWith('…')).toBe(true);
  });

  it('photo seule : type image, extrait vide quand le corps est le mot de repli', () => {
    const c = resumerCitation(
      base({ body: 'Photo', meta: { imageUrl: 'chicken-nation/messagerie/x.jpg' }, authorUser: agent }),
    )!;
    expect(c.kind).toBe('image');
    expect(c.excerpt).toBe('');
  });

  it('photo avec légende : la légende sert d\'extrait', () => {
    const c = resumerCitation(
      base({ body: 'Voici le reçu', meta: { imageUrl: 'k.jpg' }, authorCustomer: client }),
    )!;
    expect(c.kind).toBe('image');
    expect(c.excerpt).toBe('Voici le reçu');
    expect(c.author).toEqual({ kind: 'customer', id: 'c1', name: 'Yao Kouassi' });
  });

  it('note vocale : type audio, extrait vide pour « Message vocal »', () => {
    const c = resumerCitation(
      base({ body: 'Message vocal', meta: { audioUrl: 'a.m4a', audioDurationMs: 4000 }, authorUser: agent }),
    )!;
    expect(c.kind).toBe('audio');
    expect(c.excerpt).toBe('');
  });

  it("alerte : type alert, première ligne seulement, auteur « Système »", () => {
    const c = resumerCitation(
      base({
        body: '⚠️ Commande en retard\nRéférence CN-0042\nRestaurant Zone 4',
        meta: { type: 'ALERTE', code: 'RETARD' },
      }),
    )!;
    expect(c.kind).toBe('alert');
    expect(c.excerpt).toBe('⚠️ Commande en retard');
    expect(c.author).toEqual({ kind: 'system', id: null, name: 'Système' });
  });

  it('diffusion : auteur « Chicken Nation »', () => {
    const c = resumerCitation(base({ body: 'Promo du jour', broadcastId: 'b1' }))!;
    expect(c.author).toEqual({ kind: 'broadcast', id: null, name: 'Chicken Nation' });
  });

  it('original supprimé : texte de remplacement, type texte, aucune méta', () => {
    const c = resumerCitation(
      base({
        body: 'Code secret 1234',
        meta: { imageUrl: 'k.jpg' },
        deletedAt: new Date(),
        authorUser: agent,
      }),
    )!;
    expect(c.deleted).toBe(true);
    expect(c.kind).toBe('text');
    expect(c.excerpt).toBe(CORPS_MESSAGE_SUPPRIME);
    expect(JSON.stringify(c)).not.toContain('1234');
    expect(JSON.stringify(c)).not.toContain('k.jpg');
  });

  it("lecteur client : l'agent cité devient « Chicken Nation », sans identifiant", () => {
    const c = resumerCitation(base({ authorUser: agent }), 'customer')!;
    expect(c.author).toEqual({ kind: 'user', id: null, name: 'Chicken Nation' });
    expect(JSON.stringify(c)).not.toContain('Awa');
  });

  it('lecteur client : ses propres messages gardent son nom (pour « Vous »)', () => {
    const c = resumerCitation(base({ authorCustomer: client }), 'customer')!;
    expect(c.author).toEqual({ kind: 'customer', id: 'c1', name: 'Yao Kouassi' });
  });
});

describe('versionClient', () => {
  it("renomme l'agent cité et vide les mentions, sans toucher au reste", () => {
    const message = {
      id: 'r1',
      body: '@Awa Koné regarde',
      replyTo: resumerCitation(base({ authorUser: agent })),
      mentions: [{ userId: 'u1', label: 'Awa Koné' }],
    };
    const v = versionClient(message);
    expect(v.replyTo?.author).toEqual({ kind: 'user', id: null, name: 'Chicken Nation' });
    expect(v.mentions).toEqual([]);
    expect(v.body).toBe(message.body);
    // L'original n'est pas modifié : la charge du personnel reste intacte.
    expect(message.replyTo?.author.name).toBe('Awa Koné');
    expect(message.mentions).toHaveLength(1);
  });

  it('même résultat que resumerCitation lue par un client', () => {
    const brute = base({ authorUser: agent, body: 'Bien reçu' });
    const parLeServeur = versionClient({ replyTo: resumerCitation(brute), mentions: [] }).replyTo;
    expect(parLeServeur).toEqual(resumerCitation(brute, 'customer'));
  });

  it('citation absente ou non agent : inchangée', () => {
    expect(versionClient({ replyTo: null, mentions: [] }).replyTo).toBeNull();
    expect(versionClient({ mentions: undefined }).replyTo).toBeNull();
    const duClient = resumerCitation(base({ authorCustomer: client }));
    expect(versionClient({ replyTo: duClient, mentions: [] }).replyTo).toEqual(duClient);
  });
});

/** Une moitié d'emoji isolée (unité de substitution sans sa partenaire). */
const moitieOrpheline = (texte: string) =>
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(texte);

describe('couper sans casser un emoji', () => {
  it('couperSansCasser recule quand la coupe tombe au milieu d’un emoji', () => {
    // « ab👍 » : 4 unités, l'emoji en occupe deux (2 et 3).
    expect(couperSansCasser('ab👍', 3)).toBe('ab');
    expect(couperSansCasser('ab👍', 4)).toBe('ab👍');
    expect(couperSansCasser('ab👍c', 2)).toBe('ab');
    expect(couperSansCasser('abc', 0)).toBe('');
  });

  it('couperAuMot ne laisse jamais une moitié d’emoji, à toutes les positions', () => {
    for (let decalage = 0; decalage < 4; decalage += 1) {
      const texte = 'x'.repeat(150 + decalage) + '👍'.repeat(20);
      const coupe = couperAuMot(texte, LONGUEUR_EXTRAIT_CITATION);
      expect(coupe.length).toBeLessThanOrEqual(LONGUEUR_EXTRAIT_CITATION);
      expect(coupe.endsWith('…')).toBe(true);
      expect(moitieOrpheline(coupe)).toBe(false);
    }
  });

  it('extrait de citation plein d’emojis : toujours une chaîne valide', () => {
    const c = resumerCitation(base({ body: '🍗'.repeat(200), authorUser: agent }))!;
    expect(c.excerpt.length).toBeLessThanOrEqual(LONGUEUR_EXTRAIT_CITATION);
    expect(moitieOrpheline(c.excerpt)).toBe(false);
  });
});
