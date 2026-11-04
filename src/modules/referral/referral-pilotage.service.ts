import { Injectable } from '@nestjs/common';
import {
  EntityStatus,
  Prisma,
  ReferralEarningStatus,
  ReferralEarningType,
  ReferralStatus,
  RewardStatus,
  UserRole,
} from '@prisma/client';
import { addDays, addMonths, differenceInDays, format, startOfDay, startOfMonth } from 'date-fns';
import { PrismaService } from 'src/database/services/prisma.service';
import {
  BaseStatsQuery,
  FILTRE_VENTE,
  getPreviousPeriod,
  parseDateRange,
} from 'src/modules/statistics/helpers/statistics.helper';
import { nomComplet, ReferralService } from './referral.service';
import {
  EtatFilleul,
  EtatParrain,
  PasCourbe,
  Periode,
  sqlChiffresFilleuls,
  sqlChiffresVentes,
  sqlCompteursParrains,
  sqlCourbeFilleuls,
  sqlCourbeVentes,
  sqlPageParrains,
  sqlSoldes,
  TriParrain,
} from './referral-pilotage.sql';

/** Où en est le cadeau du filleul. Qualifié = il l'a utilisé sur une commande. */
export type EtatCadeau = 'A_GRATTER' | 'GRATTE' | 'UTILISE' | 'EXPIRE' | 'RETIRE';

/** Sans période ni dates : tout le programme, depuis le premier filleul. */
export function lirePeriode(q: Pick<BaseStatsQuery, 'period' | 'startDate' | 'endDate'>): Periode {
  if (!q.period && !(q.startDate && q.endDate)) return null;
  const { startDate, endDate } = parseDateRange(q);
  return { debut: startDate, fin: endDate };
}

/** Dates de la courbe : au jour jusqu'à deux mois, au mois au-delà. */
export function datesDeCourbe(debut: Date, fin: Date): { pas: PasCourbe; dates: string[] } {
  const pas: PasCourbe = differenceInDays(fin, debut) <= 62 ? 'jour' : 'mois';
  const dates: string[] = [];
  let d = pas === 'jour' ? startOfDay(debut) : startOfMonth(debut);
  while (d <= fin) {
    dates.push(format(d, pas === 'jour' ? 'yyyy-MM-dd' : 'yyyy-MM'));
    d = pas === 'jour' ? addDays(d, 1) : addMonths(d, 1);
  }
  return { pas, dates };
}

/** État du cadeau d'un filleul, `null` pour les filleuls d'avant le cadeau à gratter. */
export function etatCadeau(
  statutParrainage: ReferralStatus,
  cadeau: { status: RewardStatus; expires_at: Date | null } | null | undefined,
  maintenant: Date,
): EtatCadeau | null {
  if (!cadeau) return null;
  if (statutParrainage === ReferralStatus.REWARDED || cadeau.status === RewardStatus.CONSUMED) return 'UTILISE';
  if (cadeau.status === RewardStatus.REVOKED) return 'RETIRE';
  if (cadeau.expires_at && cadeau.expires_at < maintenant) return 'EXPIRE';
  return cadeau.status === RewardStatus.SCRATCHED ? 'GRATTE' : 'A_GRATTER';
}

type LigneParrain = {
  id: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  referral_code: string | null;
  referral_code_ancien: string | null;
  filleuls: number;
  qualifies: number;
  dernier_filleul: Date | null;
  ventes: number;
  en_attente: number;
  payable: number;
  paye: number;
};

type ChiffresFilleuls = {
  inscrits: number;
  qualifies: number;
  en_attente: number;
  annules: number;
  parrains_actifs: number;
  ont_commande: number;
};

type ChiffresVentes = { montant: number; commandes: number };

type Soldes = {
  en_attente: number;
  parrains_en_attente: number;
  payable: number;
  parrains_payable: number;
  paye: number;
  parrains_paye: number;
  primes: number;
  commissions: number;
};

const pagination = (q: { page?: number; limit?: number }, defaut: number) => {
  const page = Math.max(1, Math.floor(Number(q.page) || 1));
  const limit = Math.min(Math.max(1, Math.floor(Number(q.limit) || defaut)), 50);
  return { page, limit };
};

const aucunMot = (filtre: object) => Object.keys(filtre).length === 0;

/**
 * Pilotage du parrainage au backoffice : chiffres du programme et listes
 * filtrées (parrains, filleuls, gains). Lecture seule ; les gestes restent
 * dans `ReferralService`.
 */
@Injectable()
export class ReferralPilotageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly referral: ReferralService,
  ) {}

  /** Chiffres du programme sur la période, soldes à ce jour, courbes. */
  async tableau(q: Pick<BaseStatsQuery, 'period' | 'startDate' | 'endDate'>) {
    const periode = lirePeriode(q);
    const precedente = periode ? getPreviousPeriod(periode.debut, periode.fin) : null;
    const avant: Periode = precedente && { debut: precedente.start, fin: precedente.end };

    const [
      [filleuls],
      [ventes],
      [soldes],
      codes,
      enAttenteParParrain,
      { payout_threshold },
      filleulsAvant,
      ventesAvant,
    ] = await Promise.all([
      this.prisma.$queryRaw<ChiffresFilleuls[]>(sqlChiffresFilleuls(periode)),
      this.prisma.$queryRaw<ChiffresVentes[]>(sqlChiffresVentes(periode)),
      this.prisma.$queryRaw<Soldes[]>(sqlSoldes()),
      this.prisma.customer.count({
        where: { referral_code: { not: null }, entity_status: { not: EntityStatus.DELETED } },
      }),
      this.prisma.referralEarning.groupBy({
        by: ['referrer_id'],
        where: { status: ReferralEarningStatus.PENDING },
        _sum: { amount: true },
      }),
      this.referral.getEarningConfig(),
      avant ? this.prisma.$queryRaw<ChiffresFilleuls[]>(sqlChiffresFilleuls(avant)) : null,
      avant ? this.prisma.$queryRaw<ChiffresVentes[]>(sqlChiffresVentes(avant)) : null,
    ]);

    return {
      parrains: { codes, actifs: filleuls.parrains_actifs },
      filleuls: {
        inscrits: filleuls.inscrits,
        ont_commande: filleuls.ont_commande,
        qualifies: filleuls.qualifies,
        en_attente: filleuls.en_attente,
        annules: filleuls.annules,
      },
      ventes,
      precedent:
        filleulsAvant && ventesAvant
          ? {
              inscrits: filleulsAvant[0].inscrits,
              qualifies: filleulsAvant[0].qualifies,
              ventes: ventesAvant[0].montant,
            }
          : null,
      soldes: {
        ...soldes,
        seuil: payout_threshold,
        // Mêmes parrains que `adminApplyPayoutThreshold`.
        parrains_au_seuil: enAttenteParParrain.filter((g) => (g._sum.amount ?? 0) >= payout_threshold).length,
      },
      courbe: await this.courbe(periode),
    };
  }

  private async courbe(periode: Periode) {
    const debut =
      periode?.debut ?? (await this.prisma.referral.aggregate({ _min: { created_at: true } }))._min.created_at;
    if (!debut) return { pas: 'jour' as PasCourbe, points: [] };

    // Pas de dates à venir : « ce mois » s'arrête à aujourd'hui.
    const maintenant = new Date();
    const fin = periode && periode.fin < maintenant ? periode.fin : maintenant;
    const { pas, dates } = datesDeCourbe(debut, fin);
    const [filleuls, ventes] = await Promise.all([
      this.prisma.$queryRaw<{ date: string; qualifies: number; en_attente: number }[]>(
        sqlCourbeFilleuls(periode, pas),
      ),
      this.prisma.$queryRaw<{ date: string; ventes: number }[]>(sqlCourbeVentes(periode, pas)),
    ]);
    return {
      pas,
      points: dates.map((date) => {
        const f = filleuls.find((l) => l.date === date);
        return {
          date,
          qualifies: f?.qualifies ?? 0,
          en_attente: f?.en_attente ?? 0,
          ventes: ventes.find((l) => l.date === date)?.ventes ?? 0,
        };
      }),
    };
  }

  /**
   * Tous les parrains, chaque client qui a un code : état, tri et période.
   * Recherche par nom, code ou téléphone (voir `filtreRecherche`).
   */
  async parrains(
    q: Pick<BaseStatsQuery, 'period' | 'startDate' | 'endDate'> & {
      page?: number;
      limit?: number;
      search?: string;
      etat?: EtatParrain;
      tri?: TriParrain;
    },
    role?: UserRole | null,
  ) {
    const { page, limit } = pagination(q, 10);
    const periode = lirePeriode(q);
    const ids = await this.idsRecherche(q.search, role);
    const [lignes, [compteurs], { payout_threshold }] = await Promise.all([
      this.prisma.$queryRaw<LigneParrain[]>(
        sqlPageParrains({
          periode,
          ids,
          etat: q.etat,
          tri: q.tri ?? 'filleuls',
          limite: limit,
          decalage: (page - 1) * limit,
        }),
      ),
      this.prisma.$queryRaw<(Record<EtatParrain, number> & { tous: number })[]>(sqlCompteursParrains(periode, ids)),
      this.referral.getEarningConfig(),
    ]);
    const total = compteurs[q.etat ?? 'tous'];
    return {
      items: lignes.map((l) => ({
        customer_id: l.id,
        fullname: nomComplet(l),
        phone: l.phone,
        referral_code: l.referral_code,
        referral_code_ancien: l.referral_code_ancien,
        referees_count: l.filleuls,
        qualified_referees_count: l.qualifies,
        last_referee_at: l.dernier_filleul,
        generated_sales: l.ventes,
        total_earned: l.en_attente + l.payable + l.paye,
        pending_amount: l.en_attente,
        payable_amount: l.payable,
        paid_amount: l.paye,
      })),
      total,
      page,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      payout_threshold,
      compteurs,
    };
  }

  /** Parrains retenus par la recherche ; `null` sans recherche. */
  private async idsRecherche(search: string | undefined, role?: UserRole | null): Promise<string[] | null> {
    const filtre = this.referral.filtreRecherche(search, role);
    if (aucunMot(filtre)) return null;
    const clients = await this.prisma.customer.findMany({
      where: { referral_code: { not: null }, ...filtre },
      select: { id: true },
      take: 500,
    });
    // Liste vide : aucun résultat, surtout pas tous les parrains.
    return clients.map((c) => c.id);
  }

  /** Tous les filleuls, du plus récent au plus ancien, avec leur parrain et leur cadeau. */
  async filleuls(
    q: Pick<BaseStatsQuery, 'period' | 'startDate' | 'endDate'> & {
      page?: number;
      limit?: number;
      search?: string;
      etat?: EtatFilleul;
    },
    role?: UserRole | null,
  ) {
    const { page, limit } = pagination(q, 10);
    const periode = lirePeriode(q);
    const recherche = this.referral.filtreRecherche(q.search, role);
    const base: Prisma.ReferralWhereInput = {
      ...(periode ? { created_at: { gte: periode.debut, lte: periode.fin } } : {}),
      ...(aucunMot(recherche) ? {} : { OR: [{ referee: recherche }, { referrer: recherche }] }),
    };
    const aCommande: Prisma.ReferralWhereInput = {
      status: ReferralStatus.PENDING,
      referee: { orders: { some: FILTRE_VENTE } },
    };
    const etats: Record<EtatFilleul, Prisma.ReferralWhereInput> = {
      en_attente: { status: ReferralStatus.PENDING },
      a_commande: aCommande,
      qualifie: { status: ReferralStatus.REWARDED },
      annule: { status: ReferralStatus.CANCELLED },
    };
    const where: Prisma.ReferralWhereInput = q.etat ? { AND: [base, etats[q.etat]] } : base;

    const [lignes, parStatut, aCommandeNb] = await Promise.all([
      this.prisma.referral.findMany({
        where,
        orderBy: [{ created_at: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          status: true,
          created_at: true,
          qualified_at: true,
          filleul_reward_id: true,
          referral_code: true,
          referee: { select: { id: true, first_name: true, last_name: true, phone: true } },
          referrer: { select: { id: true, first_name: true, last_name: true, referral_code: true } },
        },
      }),
      this.prisma.referral.groupBy({ by: ['status'], where: base, _count: { _all: true } }),
      this.prisma.referral.count({ where: { AND: [base, aCommande] } }),
    ]);

    const nb = (statut: ReferralStatus) => parStatut.find((g) => g.status === statut)?._count._all ?? 0;
    const compteurs = {
      tous: nb(ReferralStatus.PENDING) + nb(ReferralStatus.REWARDED) + nb(ReferralStatus.CANCELLED),
      en_attente: nb(ReferralStatus.PENDING),
      a_commande: aCommandeNb,
      qualifie: nb(ReferralStatus.REWARDED),
      annule: nb(ReferralStatus.CANCELLED),
    };

    const idsCadeaux = lignes.map((l) => l.filleul_reward_id).filter((id): id is string => !!id);
    const [ventes, cadeaux] = await Promise.all([
      this.referral.ventesParClient(lignes.map((l) => l.referee.id)),
      this.prisma.reward.findMany({
        where: { id: { in: idsCadeaux } },
        select: { id: true, status: true, expires_at: true },
      }),
    ]);

    const maintenant = new Date();
    const total = compteurs[q.etat ?? 'tous'];
    return {
      items: lignes.map((l) => ({
        id: l.id,
        customer_id: l.referee.id,
        fullname: nomComplet(l.referee),
        phone: l.referee.phone,
        status: l.status,
        joined_at: l.created_at,
        qualified_at: l.qualified_at,
        sales: ventes.get(l.referee.id)?.montant ?? 0,
        orders_count: ventes.get(l.referee.id)?.commandes ?? 0,
        gift: etatCadeau(l.status, cadeaux.find((c) => c.id === l.filleul_reward_id), maintenant),
        referrer_id: l.referrer.id,
        referrer_name: nomComplet(l.referrer),
        referrer_code: l.referrer.referral_code,
      })),
      total,
      page,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      compteurs,
    };
  }

  /** Tous les gains, du plus récent au plus ancien : état, type, période, recherche. */
  async gains(
    q: Pick<BaseStatsQuery, 'period' | 'startDate' | 'endDate'> & {
      referrer_id?: string;
      status?: ReferralEarningStatus;
      type?: ReferralEarningType;
      search?: string;
      page?: number;
      limit?: number;
    },
    role?: UserRole | null,
  ) {
    const { page, limit } = pagination(q, 10);
    const periode = lirePeriode(q);
    const recherche = this.referral.filtreRecherche(q.search, role);
    const base: Prisma.ReferralEarningWhereInput = {
      ...(q.referrer_id ? { referrer_id: q.referrer_id } : {}),
      ...(q.type ? { type: q.type } : {}),
      ...(periode ? { created_at: { gte: periode.debut, lte: periode.fin } } : {}),
      ...(aucunMot(recherche)
        ? {}
        : { referral: { OR: [{ referrer: recherche }, { referee: recherche }] } }),
    };
    const where: Prisma.ReferralEarningWhereInput = q.status ? { ...base, status: q.status } : base;

    const [lignes, parStatut] = await Promise.all([
      this.prisma.referralEarning.findMany({
        where,
        orderBy: [{ created_at: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          type: true,
          status: true,
          amount: true,
          referee_id: true,
          referrer_id: true,
          source_order_id: true,
          created_at: true,
          paid_at: true,
          note: true,
          referral: {
            select: {
              referrer: { select: { first_name: true, last_name: true, referral_code: true } },
              referee: { select: { first_name: true, last_name: true } },
            },
          },
        },
      }),
      this.prisma.referralEarning.groupBy({
        by: ['status'],
        where: base,
        _count: { _all: true },
        _sum: { amount: true },
      }),
    ]);

    const idsCommandes = lignes.map((l) => l.source_order_id).filter((id): id is string => !!id);
    const commandes = await this.prisma.order.findMany({
      where: { id: { in: idsCommandes } },
      select: { id: true, reference: true, net_amount: true },
    });

    const nb = (statut: ReferralEarningStatus) => parStatut.find((g) => g.status === statut)?._count._all ?? 0;
    const compteurs = {
      tous: parStatut.reduce((t, g) => t + g._count._all, 0),
      PENDING: nb(ReferralEarningStatus.PENDING),
      PAYABLE: nb(ReferralEarningStatus.PAYABLE),
      PAID: nb(ReferralEarningStatus.PAID),
      CANCELLED: nb(ReferralEarningStatus.CANCELLED),
    };
    // Un gain annulé ne compte dans le total que si on regarde les annulés.
    const montant = parStatut
      .filter((g) => (q.status ? g.status === q.status : g.status !== ReferralEarningStatus.CANCELLED))
      .reduce((t, g) => t + (g._sum.amount ?? 0), 0);
    const total = compteurs[q.status ?? 'tous'];

    return {
      items: lignes.map((l) => {
        const commande = commandes.find((c) => c.id === l.source_order_id);
        return {
          id: l.id,
          kind: l.type,
          status: l.status,
          amount: l.amount,
          referrer_id: l.referrer_id,
          referrer_name: nomComplet(l.referral.referrer),
          referrer_code: l.referral.referrer.referral_code,
          referee_id: l.referee_id,
          referee_name: nomComplet(l.referral.referee),
          order_id: l.source_order_id,
          order_number: commande?.reference ?? null,
          order_amount: commande?.net_amount ?? null,
          created_at: l.created_at,
          paid_at: l.paid_at,
          note: l.note,
        };
      }),
      total,
      page,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      compteurs,
      montant,
    };
  }
}
