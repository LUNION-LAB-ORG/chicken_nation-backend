/**
 * Plats réservés à une audience, contrôlés à la création de commande (02/10).
 *
 * La règle doit dire exactement ce que dit le masque des lectures
 * (`dishAudienceClause`) : un client ne commande que ce qu'on lui montre.
 */
import { DishAudience, LoyaltyLevel, Prisma, ProfileType } from '@prisma/client';
import {
  dishAudienceClause,
  libelleReservation,
  messagePlatsReserves,
  PlatAudience,
  platsHorsAudience,
} from './dish-audience.util';

const { ETUDIANT, STANDARD, VIP, VVIP } = DishAudience;

const plat = (id: string, audiences?: DishAudience[] | null, name = `Plat ${id}`): PlatAudience => ({
  id,
  name,
  audiences,
});

type Client = { profile_type?: ProfileType | null; loyalty_level?: LoyaltyLevel | null } | null;

const CLIENTS: Record<string, Client> = {
  invite: null,
  niveauNul: { profile_type: null, loyalty_level: null },
  standard: { profile_type: ProfileType.PROFESSIONNEL, loyalty_level: LoyaltyLevel.STANDARD },
  vip: { profile_type: ProfileType.PROFESSIONNEL, loyalty_level: LoyaltyLevel.VIP },
  vvip: { profile_type: ProfileType.PROFESSIONNEL, loyalty_level: LoyaltyLevel.VVIP },
  etudiantStandard: { profile_type: ProfileType.ETUDIANT, loyalty_level: LoyaltyLevel.STANDARD },
  etudiantVip: { profile_type: ProfileType.ETUDIANT, loyalty_level: LoyaltyLevel.VIP },
};

/** Le plat passe-t-il, seul dans le panier ? */
const passe = (audiences: DishAudience[] | null | undefined, client: Client) =>
  platsHorsAudience([{ dish_id: 'p' }], [plat('p', audiences)], client).length === 0;

describe('platsHorsAudience : matrice', () => {
  it('plat public ([] ou absent) : toujours accepté, invité compris', () => {
    for (const client of Object.values(CLIENTS)) {
      expect(passe([], client)).toBe(true);
      expect(passe(undefined, client)).toBe(true);
      expect(passe(null, client)).toBe(true);
    }
  });

  it('[VIP] : accepté pour un VIP, refusé pour un VVIP, un STANDARD, un niveau nul et un invité', () => {
    expect(passe([VIP], CLIENTS.vip)).toBe(true);
    expect(passe([VIP], CLIENTS.vvip)).toBe(false);
    expect(passe([VIP], CLIENTS.standard)).toBe(false);
    expect(passe([VIP], CLIENTS.niveauNul)).toBe(false);
    expect(passe([VIP], CLIENTS.invite)).toBe(false);
  });

  it('[STANDARD] : accepté pour un niveau nul (vu comme STANDARD), refusé pour un VIP et un VVIP', () => {
    expect(passe([STANDARD], CLIENTS.niveauNul)).toBe(true);
    expect(passe([STANDARD], CLIENTS.standard)).toBe(true);
    expect(passe([STANDARD], CLIENTS.vip)).toBe(false);
    expect(passe([STANDARD], CLIENTS.vvip)).toBe(false);
  });

  it('[ETUDIANT] : accepté pour un étudiant STANDARD, refusé pour un non étudiant', () => {
    expect(passe([ETUDIANT], CLIENTS.etudiantStandard)).toBe(true);
    expect(passe([ETUDIANT], CLIENTS.etudiantVip)).toBe(true);
    expect(passe([ETUDIANT], CLIENTS.standard)).toBe(false);
    expect(passe([ETUDIANT], CLIENTS.vip)).toBe(false);
  });

  it('[ETUDIANT, VIP] : accepté pour un VIP non étudiant', () => {
    expect(passe([ETUDIANT, VIP], CLIENTS.vip)).toBe(true);
    expect(passe([ETUDIANT, VIP], CLIENTS.etudiantStandard)).toBe(true);
    expect(passe([ETUDIANT, VIP], CLIENTS.standard)).toBe(false);
  });
});

describe('platsHorsAudience : lignes', () => {
  const plats = [plat('vip', [VIP], 'Menu Prestige'), plat('public', [])];

  it('ligne-cadeau exemptée acceptée, même plat refusé sur une autre ligne payante', () => {
    const lignes = [{ dish_id: 'public' }, { dish_id: 'vip' }];
    expect(platsHorsAudience(lignes, plats, CLIENTS.standard, new Set([1]))).toEqual([]);

    const avecPayante = [{ dish_id: 'public' }, { dish_id: 'vip' }, { dish_id: 'vip' }];
    expect(platsHorsAudience(avecPayante, plats, CLIENTS.standard, new Set([1])).map((p) => p.id)).toEqual(['vip']);
  });

  it('plat introuvable dans la liste : ligne ignorée (déjà refusée par la lecture des plats)', () => {
    expect(platsHorsAudience([{ dish_id: 'inconnu' }], plats, CLIENTS.standard)).toEqual([]);
    // Simulation existante : liste de plats vide.
    expect(platsHorsAudience([{ dish_id: 'vip' }], [], CLIENTS.standard)).toEqual([]);
  });

  it('chaque plat refusé une seule fois, dans l’ordre du panier', () => {
    const tous = [plat('a', [ETUDIANT]), plat('b', [VIP]), plat('c', [])];
    const lignes = [{ dish_id: 'b' }, { dish_id: 'c' }, { dish_id: 'a' }, { dish_id: 'b' }];
    expect(platsHorsAudience(lignes, tous, CLIENTS.standard).map((p) => p.id)).toEqual(['b', 'a']);
  });
});

/** Évalue la clause Prisma de `dishAudienceClause` sur un plat en mémoire. */
function evaluer(clause: Prisma.DishWhereInput, audiences: DishAudience[]): boolean {
  if (clause.OR) return (clause.OR as Prisma.DishWhereInput[]).some((c) => evaluer(c, audiences));
  const filtre = clause.audiences as Prisma.EnumDishAudienceNullableListFilter;
  if (filtre?.isEmpty) return audiences.length === 0;
  if (filtre?.hasSome) return (filtre.hasSome as DishAudience[]).some((a) => audiences.includes(a));
  throw new Error(`clause inattendue : ${JSON.stringify(clause)}`);
}

describe('parité avec dishAudienceClause (masque des lectures)', () => {
  const combinaisons: DishAudience[][] = [
    [],
    [ETUDIANT],
    [STANDARD],
    [VIP],
    [VVIP],
    [ETUDIANT, VIP],
    [STANDARD, VIP],
    [VIP, VVIP],
    [ETUDIANT, STANDARD, VIP, VVIP],
  ];

  for (const [nom, client] of Object.entries(CLIENTS)) {
    it(`même verdict que le masque pour le client ${nom}`, () => {
      const clause = dishAudienceClause(client);
      for (const audiences of combinaisons) {
        expect({ audiences, commandable: passe(audiences, client) }).toEqual({
          audiences,
          commandable: evaluer(clause, audiences),
        });
      }
    });
  }
});

describe('messagePlatsReserves', () => {
  it('un plat, une audience : le message de l’analyse, mot pour mot', () => {
    expect(messagePlatsReserves([plat('m', [ETUDIANT], 'Menu Campus')])).toBe(
      'Le plat « Menu Campus » est réservé aux étudiants. Retirez-le du panier pour continuer.',
    );
  });

  it('libellés des quatre audiences, joints par « ou » dans un ordre fixe', () => {
    expect(libelleReservation([VVIP, STANDARD, VIP, ETUDIANT])).toBe(
      'aux étudiants ou aux clients du niveau Standard ou aux clients VIP ou aux clients VVIP',
    );
    expect(messagePlatsReserves([plat('m', [VIP, ETUDIANT], 'Menu Prestige')])).toBe(
      'Le plat « Menu Prestige » est réservé aux étudiants ou aux clients VIP. Retirez-le du panier pour continuer.',
    );
  });

  it('plusieurs plats : chacun nommé, regroupés par public', () => {
    const message = messagePlatsReserves([
      plat('a', [VIP], 'Menu Prestige'),
      plat('b', [ETUDIANT], 'Menu Campus'),
      plat('c', [VIP], 'Burger Or'),
    ]);
    expect(message).toBe(
      'Les plats « Menu Prestige » et « Burger Or » sont réservés aux clients VIP. ' +
        'Le plat « Menu Campus » est réservé aux étudiants. Retirez-les du panier pour continuer.',
    );
  });

  it('jamais la phrase que l’application intercepte, jamais de tiret cadratin', () => {
    const message = messagePlatsReserves([plat('a', [VVIP], 'A'), plat('b', [STANDARD], 'B')]);
    expect(message).not.toContain('en choisissant ses options');
    expect(message).not.toContain('—');
  });
});
