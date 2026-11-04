import { ReferralEarningStatus, ReferralStatus, RewardStatus, UserRole } from '@prisma/client';
import { datesDeCourbe, etatCadeau, lirePeriode, ReferralPilotageService } from './referral-pilotage.service';
import { sqlPageParrains } from './referral-pilotage.sql';

describe('Pilotage du parrainage : règles', () => {
  it('sans période ni dates : tout le programme', () => {
    expect(lirePeriode({})).toBeNull();
    expect(lirePeriode({ startDate: '2026-11-01' })).toBeNull();
  });

  it('période prédéfinie ou dates : une plage', () => {
    expect(lirePeriode({ period: 'month' })).toEqual({ debut: expect.any(Date), fin: expect.any(Date) });
    const p = lirePeriode({ startDate: '2026-11-01', endDate: '2026-11-03' })!;
    expect(p.fin.getTime()).toBeGreaterThan(p.debut.getTime());
  });

  it('courbe au jour jusqu’à deux mois, au mois au-delà, sans trou', () => {
    expect(datesDeCourbe(new Date(2026, 10, 1, 8), new Date(2026, 10, 3, 9))).toEqual({
      pas: 'jour',
      dates: ['2026-11-01', '2026-11-02', '2026-11-03'],
    });
    expect(datesDeCourbe(new Date(2026, 7, 20), new Date(2026, 10, 3))).toEqual({
      pas: 'mois',
      dates: ['2026-08', '2026-09', '2026-10', '2026-11'],
    });
  });

  it('état du cadeau du filleul', () => {
    const hier = new Date(2026, 10, 3);
    const maintenant = new Date(2026, 10, 4);
    const cadeau = (status: RewardStatus, expires_at: Date | null = null) => ({ status, expires_at });
    const { PENDING, REWARDED } = ReferralStatus;

    expect(etatCadeau(PENDING, null, maintenant)).toBeNull();
    expect(etatCadeau(PENDING, cadeau(RewardStatus.PENDING), maintenant)).toBe('A_GRATTER');
    expect(etatCadeau(PENDING, cadeau(RewardStatus.PENDING, hier), maintenant)).toBe('EXPIRE');
    expect(etatCadeau(PENDING, cadeau(RewardStatus.SCRATCHED), maintenant)).toBe('GRATTE');
    expect(etatCadeau(PENDING, cadeau(RewardStatus.CONSUMED), maintenant)).toBe('UTILISE');
    expect(etatCadeau(PENDING, cadeau(RewardStatus.REVOKED), maintenant)).toBe('RETIRE');
    // Un bon gratté reste SCRATCHED une fois utilisé : seule la qualification le dit.
    expect(etatCadeau(REWARDED, cadeau(RewardStatus.SCRATCHED), maintenant)).toBe('UTILISE');
  });

  it('le tri vient d’une liste fermée et les pages sont des entiers', () => {
    const q = sqlPageParrains({ periode: null, ids: null, tri: 'ventes', limite: 10.9, decalage: 20 });
    expect(q.text).toContain('ORDER BY ventes DESC');
    expect(q.text).toContain('LIMIT 10 OFFSET 20');
  });
});

describe('Pilotage du parrainage : listes', () => {
  const service = (prisma: any, recherche: object = {}) => {
    const s = Object.create(ReferralPilotageService.prototype) as ReferralPilotageService;
    (s as any).prisma = prisma;
    (s as any).referral = {
      filtreRecherche: jest.fn().mockReturnValue(recherche),
      getEarningConfig: jest.fn().mockResolvedValue({ payout_threshold: 5000 }),
      ventesParClient: jest.fn().mockResolvedValue(new Map()),
    };
    return s;
  };

  it('parrains : une recherche sans résultat ne rend pas tous les parrains', async () => {
    const queryRaw = jest.fn().mockResolvedValue([{ tous: 0, payable: 0 }]);
    const s = service(
      { customer: { findMany: jest.fn().mockResolvedValue([]) }, $queryRaw: queryRaw },
      { OR: [{ first_name: 'x' }] },
    );
    await s.parrains({ search: 'personne' });
    expect(queryRaw.mock.calls[0][0].text).toContain('AND FALSE');
  });

  it('parrains : le total suit l’état choisi, et le rôle masqué va jusqu’à la recherche', async () => {
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ tous: 30, payable: 4 }]);
    const s = service({ $queryRaw: queryRaw });
    const res = await s.parrains({ etat: 'payable', limit: 3 }, UserRole.MARKETING);
    expect(res).toMatchObject({ total: 4, totalPages: 2, payout_threshold: 5000 });
    expect((s as any).referral.filtreRecherche).toHaveBeenCalledWith(undefined, UserRole.MARKETING);
  });

  it('gains : un gain annulé ne compte dans le total que si on regarde les annulés', async () => {
    const groupes = [
      { status: ReferralEarningStatus.PAYABLE, _count: { _all: 2 }, _sum: { amount: 1000 } },
      { status: ReferralEarningStatus.CANCELLED, _count: { _all: 1 }, _sum: { amount: 700 } },
    ];
    const prisma = {
      referralEarning: {
        findMany: jest.fn().mockResolvedValue([]),
        groupBy: jest.fn().mockResolvedValue(groupes),
      },
      order: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const s = service(prisma);
    expect(await s.gains({})).toMatchObject({ montant: 1000, total: 3 });
    expect(await s.gains({ status: ReferralEarningStatus.CANCELLED })).toMatchObject({ montant: 700, total: 1 });
  });

  it('filleuls : « a commandé » reste en attente, et les compteurs ne dépendent pas de l’état choisi', async () => {
    const prisma = {
      referral: {
        findMany: jest.fn().mockResolvedValue([]),
        groupBy: jest.fn().mockResolvedValue([
          { status: ReferralStatus.PENDING, _count: { _all: 5 } },
          { status: ReferralStatus.REWARDED, _count: { _all: 2 } },
        ]),
        count: jest.fn().mockResolvedValue(3),
      },
      reward: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const s = service(prisma);
    const res = await s.filleuls({ etat: 'a_commande' });
    expect(res.compteurs).toEqual({ tous: 7, en_attente: 5, a_commande: 3, qualifie: 2, annule: 0 });
    expect(res.total).toBe(3);
    const { AND } = prisma.referral.findMany.mock.calls[0][0].where;
    expect(AND[1]).toMatchObject({ status: ReferralStatus.PENDING, referee: { orders: { some: { paied: true } } } });
    expect(prisma.referral.groupBy.mock.calls[0][0].where).toEqual({});
  });
});
