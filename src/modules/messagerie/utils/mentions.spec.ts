import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateMessageDto } from '../dto/createMessageDto';
import {
  filtrerMentions,
  LecteurMembres,
  MAX_MENTIONS,
  MembreMentionnable,
  normaliserListeIds,
  resoudreMentions,
} from './mentions';

const U = {
  auteur: '11111111-1111-4111-8111-111111111111',
  awa: '22222222-2222-4222-8222-222222222222',
  cuisine: '33333333-3333-4333-8333-333333333333',
  inactif: '44444444-4444-4444-8444-444444444444',
  horsGroupe: '55555555-5555-4555-8555-555555555555',
  marketing: '66666666-6666-4666-8666-666666666666',
  comptable: '77777777-7777-4777-8777-777777777777',
};

const membres: MembreMentionnable[] = [
  { id: U.auteur, fullname: 'Jean Yao', role: 'ADMIN', entity_status: 'ACTIVE' },
  { id: U.awa, fullname: 'Awa Koné', role: 'CAISSIER', entity_status: 'ACTIVE' },
  { id: U.cuisine, fullname: 'Koffi Cuisine', role: 'CUISINE', entity_status: 'ACTIVE' },
  { id: U.inactif, fullname: 'Ancien Agent', role: 'MANAGER', entity_status: 'INACTIVE' },
  { id: U.marketing, fullname: 'Marie Marketing', role: 'MARKETING', entity_status: 'ACTIVE' },
  { id: U.comptable, fullname: 'Paul Compta', role: 'COMPTABLE', entity_status: 'ACTIVE' },
];

/** Faux Prisma : ne rend que les membres DE la conversation parmi ceux demandés. */
function prismaAvec(liste: MembreMentionnable[]) {
  const findMany = jest.fn(async (args: { where: { userId: { in: string[] } } }) =>
    liste.filter((m) => args.where.userId.in.includes(m.id)).map((user) => ({ user })),
  );
  return { prisma: { conversationUser: { findMany } } as unknown as LecteurMembres, findMany };
}

const interne = { id: 'conv-interne', customerId: null };

describe('normaliserListeIds', () => {
  it('absent ou chaîne vide : rien', () => {
    expect(normaliserListeIds(undefined)).toBeUndefined();
    expect(normaliserListeIds(null)).toBeUndefined();
    expect(normaliserListeIds('')).toBeUndefined();
    expect(normaliserListeIds('   ')).toBeUndefined();
  });

  it('chaîne seule (FormData à un élément) : une liste', () => {
    expect(normaliserListeIds(U.awa)).toEqual([U.awa]);
  });

  it('tableau JSON sérialisé : relu', () => {
    expect(normaliserListeIds(JSON.stringify([U.awa, U.auteur]))).toEqual([U.awa, U.auteur]);
  });

  it('tableau : blancs et vides retirés', () => {
    expect(normaliserListeIds([` ${U.awa} `, '', U.auteur])).toEqual([U.awa, U.auteur]);
  });

  it('liste séparée par des virgules : découpée', () => {
    expect(normaliserListeIds(`${U.awa}, ${U.auteur}`)).toEqual([U.awa, U.auteur]);
  });

  it("forme inconnue : rendue telle quelle pour que la validation la refuse", () => {
    expect(normaliserListeIds(42)).toEqual([42]);
    expect(normaliserListeIds('[pas du json')).toEqual(['[pas du json']);
  });
});

describe('CreateMessageDto : mentions et réponse', () => {
  const valider = async (brut: Record<string, unknown>) => {
    const dto = plainToInstance(CreateMessageDto, brut);
    return { dto, erreurs: await validate(dto, { whitelist: true }) };
  };

  it('accepte un identifiant seul venu du multipart', async () => {
    const { dto, erreurs } = await valider({ body: 'Salut', mentionUserIds: U.awa });
    expect(erreurs).toHaveLength(0);
    expect(dto.mentionUserIds).toEqual([U.awa]);
  });

  it('refuse un identifiant mal formé', async () => {
    const { erreurs } = await valider({ body: 'Salut', mentionUserIds: ['pas-un-uuid'] });
    expect(erreurs.map((e) => e.property)).toContain('mentionUserIds');
  });

  it(`refuse plus de ${MAX_MENTIONS} mentions`, async () => {
    const trop = Array.from({ length: MAX_MENTIONS + 1 }, (_, i) =>
      `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    const { erreurs } = await valider({ body: 'Salut', mentionUserIds: trop });
    expect(erreurs.map((e) => e.property)).toContain('mentionUserIds');
  });

  it('replyToId vide vaut « pas de réponse », mal formé est refusé', async () => {
    const vide = await valider({ body: 'Salut', replyToId: '' });
    expect(vide.erreurs).toHaveLength(0);
    expect(vide.dto.replyToId).toBeUndefined();

    const faux = await valider({ body: 'Salut', replyToId: 'abc' });
    expect(faux.erreurs.map((e) => e.property)).toContain('replyToId');
  });
});

describe('filtrerMentions', () => {
  it("retient un membre éligible dont le nom figure dans le texte, avec le libellé du serveur", () => {
    expect(
      filtrerMentions({ ids: [U.awa], membres, auteurId: U.auteur, body: 'Merci @Awa Koné !' }),
    ).toEqual([{ userId: U.awa, label: 'Awa Koné' }]);
  });

  it('tolère la casse et les blancs du texte', () => {
    expect(
      filtrerMentions({ ids: [U.awa], membres, auteurId: U.auteur, body: '@awa   koné tu vois ?' }),
    ).toHaveLength(1);
  });

  it("exclut l'auteur, même s'il se nomme", () => {
    expect(
      filtrerMentions({ ids: [U.auteur], membres, auteurId: U.auteur, body: '@Jean Yao moi-même' }),
    ).toEqual([]);
  });

  it('exclut un compte inactif', () => {
    expect(
      filtrerMentions({ ids: [U.inactif], membres, auteurId: U.auteur, body: '@Ancien Agent ?' }),
    ).toEqual([]);
  });

  it('exclut CUISINE, MARKETING et COMPTABLE (pas d’accès à la messagerie)', () => {
    expect(
      filtrerMentions({
        ids: [U.cuisine, U.marketing, U.comptable],
        membres,
        auteurId: U.auteur,
        body: '@Koffi Cuisine @Marie Marketing @Paul Compta',
      }),
    ).toEqual([]);
  });

  it('exclut une mention sans « @Nom » visible dans le texte', () => {
    expect(
      filtrerMentions({ ids: [U.awa], membres, auteurId: U.auteur, body: 'Awa Koné sans arobase' }),
    ).toEqual([]);
  });

  it('dédoublonne', () => {
    expect(
      filtrerMentions({ ids: [U.awa, U.awa], membres, auteurId: U.auteur, body: '@Awa Koné' }),
    ).toHaveLength(1);
  });

  it(`plafonne à ${MAX_MENTIONS}`, () => {
    const nombreux: MembreMentionnable[] = Array.from({ length: 30 }, (_, i) => ({
      id: `id-${i}`,
      fullname: `Agent ${i} Zed`,
      role: 'CAISSIER',
      entity_status: 'ACTIVE',
    }));
    const body = nombreux.map((m) => `@${m.fullname}`).join(' ');
    expect(
      filtrerMentions({ ids: nombreux.map((m) => m.id), membres: nombreux, auteurId: U.auteur, body }),
    ).toHaveLength(MAX_MENTIONS);
  });
});

describe('filtrerMentions : un « @Nom » est un mot entier', () => {
  const AWA_SEULE = '88888888-8888-4888-8888-888888888888';
  const groupe: MembreMentionnable[] = [
    ...membres,
    { id: AWA_SEULE, fullname: 'Awa', role: 'CAISSIER', entity_status: 'ACTIVE' },
  ];
  const filtrer = (body: string, ids: string[]) =>
    filtrerMentions({ ids, membres: groupe, auteurId: U.auteur, body }).map((m) => m.label);

  it("« @Awa Koné » ne prévient pas aussi « Awa », quel que soit l'ordre demandé", () => {
    expect(filtrer('@Awa Koné tu passes ?', [AWA_SEULE, U.awa])).toEqual(['Awa Koné']);
    expect(filtrer('@Awa Koné tu passes ?', [U.awa, AWA_SEULE])).toEqual(['Awa Koné']);
  });

  it('les deux sont prévenues quand les deux sont écrites', () => {
    expect(filtrer('@Awa Koné et @Awa, venez', [AWA_SEULE, U.awa])).toEqual(['Awa', 'Awa Koné']);
  });

  it('un nom collé à un autre mot ne vaut pas mention', () => {
    expect(filtrer('@Awa Konéssa est passée', [U.awa])).toEqual([]);
    expect(filtrer('écrivez à contact@Awa Koné', [U.awa])).toEqual([]);
    expect(filtrer('@Awa2 est là', [AWA_SEULE])).toEqual([]);
  });

  it('la ponctuation et la fin du texte bornent le nom', () => {
    expect(filtrer('Merci @Awa Koné.', [U.awa])).toEqual(['Awa Koné']);
    expect(filtrer('(@Awa Koné)', [U.awa])).toEqual(['Awa Koné']);
    expect(filtrer("@Awa Koné'", [U.awa])).toEqual(['Awa Koné']);
    expect(filtrer('Vu @Awa Koné', [U.awa])).toEqual(['Awa Koné']);
  });

  it('accent décomposé dans le texte : reconnu comme le nom composé', () => {
    const decompose = '@Awa Kone\u0301 regarde';
    expect(filtrer(decompose, [U.awa])).toEqual(['Awa Koné']);
  });

  it('le plafond porte sur les mentions RETENUES, pas sur les identifiants lus', () => {
    const nombreux: MembreMentionnable[] = Array.from({ length: 30 }, (_, i) => ({
      id: `id-${i}`,
      fullname: `Agent ${i} Zed`,
      role: 'CAISSIER',
      entity_status: 'ACTIVE',
    }));
    // Les dix premiers ne figurent pas dans le texte : ils ne comptent pas.
    const body = nombreux.slice(10).map((m) => `@${m.fullname}`).join(' ');
    const retenues = filtrerMentions({
      ids: nombreux.map((m) => m.id),
      membres: nombreux,
      auteurId: U.auteur,
      body,
    });
    expect(retenues).toHaveLength(MAX_MENTIONS);
    expect(retenues[0].userId).toBe('id-10');
  });
});

describe('resoudreMentions', () => {
  it('aucune mention demandée : rien, sans lecture ni erreur, même pour un client', async () => {
    const { prisma, findMany } = prismaAvec(membres);
    await expect(
      resoudreMentions(prisma, {
        conversation: { id: 'c', customerId: 'client' },
        authType: 'customer',
        auteurId: 'client',
        body: 'Bonjour',
        ids: [],
      }),
    ).resolves.toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('auteur client : 400', async () => {
    const { prisma } = prismaAvec(membres);
    await expect(
      resoudreMentions(prisma, {
        conversation: { id: 'c', customerId: 'client' },
        authType: 'customer',
        auteurId: 'client',
        body: '@Awa Koné',
        ids: [U.awa],
      }),
    ).rejects.toThrow(new BadRequestException('Les mentions sont réservées au personnel'));
  });

  it('conversation avec un client : 400', async () => {
    const { prisma } = prismaAvec(membres);
    await expect(
      resoudreMentions(prisma, {
        conversation: { id: 'c', customerId: 'client' },
        authType: 'user',
        auteurId: U.auteur,
        body: '@Awa Koné',
        ids: [U.awa],
      }),
    ).rejects.toThrow('Les mentions sont réservées aux conversations internes');
  });

  it('non-membre de la conversation : ignoré sans échec', async () => {
    const { prisma, findMany } = prismaAvec(membres); // U.horsGroupe n'y figure pas
    await expect(
      resoudreMentions(prisma, {
        conversation: interne,
        authType: 'user',
        auteurId: U.auteur,
        body: '@Awa Koné @Intrus',
        ids: [U.awa, U.horsGroupe],
      }),
    ).resolves.toEqual([{ userId: U.awa, label: 'Awa Koné' }]);
    // La lecture est bornée à la conversation et aux seuls identifiants visés.
    expect(findMany.mock.calls[0][0].where).toEqual({
      conversationId: 'conv-interne',
      userId: { in: [U.awa, U.horsGroupe] },
    });
  });

  it('rôle sans accès à la messagerie : ignoré', async () => {
    const { prisma } = prismaAvec(membres);
    await expect(
      resoudreMentions(prisma, {
        conversation: interne,
        authType: 'user',
        auteurId: U.auteur,
        body: '@Koffi Cuisine',
        ids: [U.cuisine],
      }),
    ).resolves.toEqual([]);
  });

  it('texte absent : ignoré', async () => {
    const { prisma } = prismaAvec(membres);
    await expect(
      resoudreMentions(prisma, {
        conversation: interne,
        authType: 'user',
        auteurId: U.auteur,
        body: 'Pas de nom ici',
        ids: [U.awa],
      }),
    ).resolves.toEqual([]);
  });

  it("auteur retiré avant même la lecture", async () => {
    const { prisma, findMany } = prismaAvec(membres);
    await expect(
      resoudreMentions(prisma, {
        conversation: interne,
        authType: 'user',
        auteurId: U.auteur,
        body: '@Jean Yao',
        ids: [U.auteur],
      }),
    ).resolves.toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});
