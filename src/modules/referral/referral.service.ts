import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  Prisma,
  ReferralEarningStatus,
  ReferralEarningType,
  ReferralStatus,
  RewardStatus,
  RewardType,
} from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { SettingsService } from 'src/modules/settings/settings.service';
import { VoucherService } from 'src/modules/voucher/voucher.service';

/**
 * Parrainage. Réutilise l'existant : le bon de bienvenue du filleul via
 * `VoucherService.createForCustomer`, la récompense du parrain via le système
 * Reward (carte à gratter). Déclencheur de la récompense parrain = la 1ère
 * commande PAYÉE du filleul (anti-faux-comptes).
 *
 * Configuration (réglages backoffice) :
 *  - `reward.referral.welcome_amount` : montant du bon filleul (défaut 1000).
 *  - `reward.referral.parrain` : JSON { type, payload, expires_in_days? } de la
 *    récompense parrain (défaut VOUCHER 2000).
 *  - `reward.referral.created_by` : id User créateur des bons système (défaut =
 *    1er User).
 */
@Injectable()
export class ReferralService {
  private readonly logger = new Logger(ReferralService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settingsService: SettingsService,
    private readonly voucherService: VoucherService,
  ) {}

  /** Code de parrainage du client (généré à la 1ère demande, unique). */
  async getOrCreateReferralCode(customerId: string): Promise<string> {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { referral_code: true },
    });
    if (!customer) throw new NotFoundException('Client introuvable.');
    if (customer.referral_code) return customer.referral_code;

    for (let i = 0; i < 5; i++) {
      const code = this.generateCode();
      try {
        await this.prisma.customer.update({ where: { id: customerId }, data: { referral_code: code } });
        return code;
      } catch (e: any) {
        if (e?.code === 'P2002') continue; // collision improbable → retry
        throw e;
      }
    }
    throw new BadRequestException('Impossible de générer un code de parrainage, réessayez.');
  }

  /**
   * Applique un code de parrainage pour le filleul connecté (à l'inscription) :
   * crée le lien Referral (PENDING) et crédite le bon de bienvenue du filleul.
   * Anti-abus : pas d'auto-parrainage, filleul jamais déjà parrainé, filleul
   * NOUVEAU client (aucune commande payée).
   */
  async applyReferralCode(refereeId: string, rawCode: string) {
    const code = (rawCode ?? '').trim().toUpperCase();
    if (!code) throw new BadRequestException('Code de parrainage requis.');

    const already = await this.prisma.referral.findUnique({ where: { referee_id: refereeId } });
    if (already) throw new BadRequestException('Vous avez déjà utilisé un code de parrainage.');

    const referrer = await this.prisma.customer.findFirst({
      where: { referral_code: code },
      select: { id: true },
    });
    if (!referrer) throw new BadRequestException('Code de parrainage invalide.');
    if (referrer.id === refereeId) {
      throw new BadRequestException('Vous ne pouvez pas utiliser votre propre code.');
    }

    const paidOrder = await this.prisma.order.findFirst({
      where: { customer_id: refereeId, paied: true },
      select: { id: true },
    });
    if (paidOrder) throw new BadRequestException('Le parrainage est réservé aux nouveaux clients.');

    let referral;
    try {
      referral = await this.prisma.referral.create({
        data: {
          referrer_id: referrer.id,
          referee_id: refereeId,
          referral_code: code,
          status: ReferralStatus.PENDING,
        },
      });
    } catch (e: any) {
      // Course sur l'unicité referee_id → déjà parrainé.
      if (e?.code === 'P2002') throw new BadRequestException('Vous avez déjà utilisé un code de parrainage.');
      throw e;
    }

    // Bon de bienvenue du filleul (non bloquant : on ne casse pas l'inscription).
    const creator = await this.resolveSystemCreatorId();
    if (creator) {
      try {
        const amount = await this.getWelcomeAmount();
        const voucher = await this.voucherService.createForCustomer({
          customerId: refereeId,
          amount,
          createdBy: creator,
          expiresAt: null,
        });
        await this.prisma.referral.update({
          where: { id: referral.id },
          data: { welcome_voucher_id: voucher.id },
        });
      } catch (e: any) {
        this.logger.warn(`Bon de bienvenue parrainage échoué (filleul ${refereeId}): ${e?.message}`);
      }
    } else {
      this.logger.warn('Parrainage : aucun créateur système → bon de bienvenue non créé.');
    }

    return { applied: true, referral_id: referral.id };
  }

  /**
   * Qualifie le parrainage d'un filleul à sa 1ère commande payée : claim ATOMIQUE
   * PENDING→REWARDED (une seule fois, safe double-backend), puis crée la récompense
   * du parrain (carte à gratter configurée). Appelé par {@link accrueForPaidOrder}.
   * Retourne `true` si CE traitement a gagné la transition (1re qualification), sinon
   * `false` (déjà récompensé / pas de parrainage en attente).
   */
  async qualifyReferralForPaidOrder(refereeId: string, orderId: string): Promise<boolean> {
    const claim = await this.prisma.referral.updateMany({
      where: { referee_id: refereeId, status: ReferralStatus.PENDING },
      data: {
        status: ReferralStatus.REWARDED,
        qualifying_order_id: orderId,
        qualified_at: new Date(),
        updated_at: new Date(),
      },
    });
    if (claim.count === 0) return false; // pas de parrainage en attente / déjà récompensé

    const referral = await this.prisma.referral.findUnique({ where: { referee_id: refereeId } });
    if (!referral) return true;

    try {
      const reward = await this.createParrainReward(referral.referrer_id);
      if (reward) {
        await this.prisma.referral.update({
          where: { id: referral.id },
          data: { parrain_reward_id: reward.id },
        });
      }
      this.logger.log(`Parrainage qualifié (filleul ${refereeId}) → parrain ${referral.referrer_id} récompensé.`);
    } catch (e: any) {
      this.logger.error(`Échec récompense parrain (parrainage ${referral.id}): ${e?.message}`);
    }
    return true;
  }

  /**
   * VOLET MONÉTAIRE (Phase 5) — Accrual des gains de l'ambassadeur au paiement d'une
   * commande du filleul. ENGLOBE la qualification (carte à gratter parrain + PRIME) ET
   * la COMMISSION. Appelé depuis le flux de paiement (kkiapay listener), à la place de
   * `qualifyReferralForPaidOrder`. No-op si le filleul n'est pas parrainé.
   *
   * Règles :
   *  - PRIME : à la 1re commande QUALIFIANTE (transition PENDING→REWARDED) ET si le CA
   *    (net_amount) atteint le panier minimum `min_qualifying_basket` (RG-11).
   *  - COMMISSION : filleul DÉJÀ qualifié et commande DANS LA FENÊTRE
   *    (created_at ≤ qualified_at + `commission_window_days`, défaut 90 j) →
   *    `round(commission_pct% × net_amount)`.
   *  - PLAFOND (RG-14) : le cumul (PRIME+COMMISSION) par filleul ne dépasse pas
   *    `cap_per_referee` ; la nouvelle earning est bornée (ou ignorée si atteint).
   *  - IDEMPOTENT par (source_order_id, type) : P2002 → no-op. Les erreurs DB
   *    transitoires sont RELANCÉES (retry BullMQ garantit l'accrual, sans doublon).
   */
  async accrueForPaidOrder(refereeId: string, orderId: string): Promise<void> {
    const referral = await this.prisma.referral.findUnique({ where: { referee_id: refereeId } });
    if (!referral) return; // filleul non parrainé → rien à faire

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, net_amount: true, created_at: true },
    });
    if (!order) return;
    const netAmount = order.net_amount ?? 0;
    const orderDate = order.created_at ?? new Date();

    // 1) Qualification (claim atomique) + carte à gratter parrain existante.
    const justQualified = await this.qualifyReferralForPaidOrder(refereeId, orderId);

    const config = await this.getEarningConfig();

    if (justQualified) {
      // 2) PRIME — seule la commande qualifiante y donne droit (RG-11 : panier mini).
      if (netAmount >= config.min_qualifying_basket && config.prime_amount > 0) {
        await this.createEarning({
          referral,
          refereeId,
          orderId,
          type: ReferralEarningType.PRIME,
          rawAmount: config.prime_amount,
          cap: config.cap_per_referee,
        });
      } else {
        this.logger.log(
          `Parrainage : commande qualifiante ${orderId} sous le panier mini ` +
            `(${netAmount} < ${config.min_qualifying_basket}) → pas de prime.`,
        );
      }
    } else {
      // 3) COMMISSION — relit l'état pour la fenêtre (robuste aux courses concurrentes).
      const fresh = await this.prisma.referral.findUnique({ where: { id: referral.id } });
      if (
        fresh &&
        fresh.status === ReferralStatus.REWARDED &&
        fresh.qualified_at &&
        // La commande QUALIFIANTE ne donne QUE la prime, jamais une commission —
        // y compris au REJEU (justQualified=false alors qu'on retraite la qualifiante).
        // Sans cette garde, un rejeu créerait une COMMISSION parasite (clé unique
        // (order, COMMISSION) distincte de (order, PRIME) → non bloquée par l'idempotence).
        fresh.qualifying_order_id !== orderId &&
        config.commission_pct > 0 &&
        netAmount > 0
      ) {
        const windowEnd = new Date(
          fresh.qualified_at.getTime() + config.commission_window_days * 24 * 60 * 60 * 1000,
        );
        if (orderDate <= windowEnd) {
          const commission = Math.round((config.commission_pct / 100) * netAmount);
          if (commission > 0) {
            await this.createEarning({
              referral: fresh,
              refereeId,
              orderId,
              type: ReferralEarningType.COMMISSION,
              rawAmount: commission,
              cap: config.cap_per_referee,
            });
          }
        }
      }
    }

    // 4) Anti-fraude léger (RG-12) : signal (log, PAS de blocage) si filleuls rapprochés.
    await this.flagSuspiciousIfNeeded(referral.referrer_id);
  }

  /**
   * ANNULATION de commande : révoque les gains parrainage (PRIME/COMMISSION) liés à
   * la commande — on ne rémunère pas un ambassadeur sur une commande annulée. Passe
   * PENDING/PAYABLE → CANCELLED (exclus des cumuls & du plafond RG-14). NE touche PAS
   * un gain déjà PAID : on le signale pour revue (clawback manuel hors scope). Idempotent.
   */
  async revokeEarningsForCancelledOrder(orderId: string): Promise<void> {
    const claim = await this.prisma.referralEarning.updateMany({
      where: {
        source_order_id: orderId,
        status: { in: [ReferralEarningStatus.PENDING, ReferralEarningStatus.PAYABLE] },
      },
      data: { status: ReferralEarningStatus.CANCELLED, updated_at: new Date() },
    });
    if (claim.count > 0) {
      this.logger.log(`Parrainage : ${claim.count} gain(s) révoqué(s) — commande ${orderId} annulée.`);
    }
    const paid = await this.prisma.referralEarning.count({
      where: { source_order_id: orderId, status: ReferralEarningStatus.PAID },
    });
    if (paid > 0) {
      this.logger.warn(
        `Parrainage : ${paid} gain(s) DÉJÀ PAYÉ(s) sur la commande annulée ${orderId} — clawback manuel à considérer.`,
      );
    }
  }

  /**
   * Crée une earning (PENDING) en respectant le PLAFOND par filleul (RG-14) et
   * l'idempotence (source_order_id, type). Borne le montant au plafond restant ;
   * ignore si le plafond est déjà atteint. P2002 (déjà comptabilisé) → no-op ;
   * toute autre erreur (transitoire) est relancée pour le retry BullMQ.
   */
  private async createEarning(p: {
    referral: { id: string; referrer_id: string };
    refereeId: string;
    orderId: string;
    type: ReferralEarningType;
    rawAmount: number;
    cap: number;
  }): Promise<void> {
    let amount = p.rawAmount;

    if (p.cap > 0) {
      const agg = await this.prisma.referralEarning.aggregate({
        where: { referee_id: p.refereeId, status: { not: ReferralEarningStatus.CANCELLED } },
        _sum: { amount: true },
      });
      const already = agg._sum.amount ?? 0;
      const remaining = p.cap - already;
      if (remaining <= 0) {
        this.logger.log(
          `Plafond parrainage atteint (filleul ${p.refereeId}, cap ${p.cap}) → ${p.type} ignorée.`,
        );
        return;
      }
      amount = Math.min(amount, remaining);
    }

    if (amount <= 0) return;

    try {
      await this.prisma.referralEarning.create({
        data: {
          referral_id: p.referral.id,
          referrer_id: p.referral.referrer_id,
          referee_id: p.refereeId,
          type: p.type,
          source_order_id: p.orderId,
          amount,
          status: ReferralEarningStatus.PENDING,
        },
      });
      this.logger.log(
        `Gain parrainage ${p.type} ${amount} FCFA (parrain ${p.referral.referrer_id}, commande ${p.orderId}).`,
      );
    } catch (e: any) {
      if (e?.code === 'P2002') return; // déjà comptabilisé pour cette commande + type
      throw e; // transitoire → relancé par le listener pour retry BullMQ
    }
  }

  /** Anti-fraude V1 (léger) : trace un signal si un parrain accumule des filleuls très
   *  rapprochés (revue admin manuelle). AUCUN blocage automatique en V1. */
  private async flagSuspiciousIfNeeded(referrerId: string): Promise<void> {
    try {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const recent = await this.prisma.referral.count({
        where: { referrer_id: referrerId, created_at: { gte: since } },
      });
      const threshold = 5;
      if (recent >= threshold) {
        this.logger.warn(
          `⚠️ ANTI-FRAUDE parrainage : le parrain ${referrerId} a ${recent} filleuls en 24 h ` +
            `(seuil ${threshold}) → revue admin recommandée.`,
        );
      }
    } catch {
      // Non bloquant : un échec de détection ne doit jamais casser l'accrual.
    }
  }

  /** Suivi du parrainage pour le client (code + compteurs). */
  async getReferralStats(customerId: string) {
    const referral_code = await this.getOrCreateReferralCode(customerId);
    const grouped = await this.prisma.referral.groupBy({
      by: ['status'],
      where: { referrer_id: customerId },
      _count: { _all: true },
    });
    const counts: Partial<Record<ReferralStatus, number>> = {};
    for (const g of grouped) counts[g.status] = g._count._all;
    const pending = counts[ReferralStatus.PENDING] ?? 0;
    const rewarded = counts[ReferralStatus.REWARDED] ?? 0;
    return { referral_code, total_referred: pending + rewarded, pending, rewarded };
  }

  /**
   * Wallet de l'ambassadeur (client connecté) : code, filleuls (données MASQUÉES RGPD),
   * ventes générées par filleul, gains, et totaux (prime / commission / solde à payer /
   * déjà payé). Le customer_id vient TOUJOURS du JWT (cloisonnement strict).
   */
  async getAmbassadorDashboard(customerId: string) {
    const referral_code = await this.getOrCreateReferralCode(customerId);

    const referrals = await this.prisma.referral.findMany({
      where: { referrer_id: customerId },
      select: {
        id: true,
        status: true,
        created_at: true,
        qualified_at: true,
        referee_id: true,
        referee: { select: { first_name: true, phone: true } },
      },
      orderBy: { created_at: 'desc' },
    });

    const refereeIds = referrals.map((r) => r.referee_id);

    // Ventes générées par filleul (CA net de ses commandes payées).
    const salesByReferee = new Map<string, number>();
    if (refereeIds.length) {
      const grouped = await this.prisma.order.groupBy({
        by: ['customer_id'],
        where: { customer_id: { in: refereeIds }, paied: true },
        _sum: { net_amount: true },
      });
      for (const g of grouped) salesByReferee.set(g.customer_id, g._sum.net_amount ?? 0);
    }

    // Gains par filleul + par type/statut (hors CANCELLED pour les gains « acquis »).
    const earnings = await this.prisma.referralEarning.findMany({
      where: { referrer_id: customerId },
      select: { referee_id: true, type: true, status: true, amount: true },
    });
    const gainsByReferee = new Map<string, number>();
    let gains_prime = 0;
    let gains_commission = 0;
    let solde_payable = 0;
    let deja_paye = 0;
    for (const e of earnings) {
      if (e.status === ReferralEarningStatus.CANCELLED) continue;
      gainsByReferee.set(e.referee_id, (gainsByReferee.get(e.referee_id) ?? 0) + e.amount);
      if (e.type === ReferralEarningType.PRIME) gains_prime += e.amount;
      else gains_commission += e.amount;
      if (e.status === ReferralEarningStatus.PAID) deja_paye += e.amount;
      else solde_payable += e.amount; // PENDING + PAYABLE = dû, pas encore versé
    }

    const filleuls = referrals.map((r) => ({
      status: r.status,
      joined_at: r.created_at,
      qualified_at: r.qualified_at,
      referee: {
        name_masked: this.maskName(r.referee?.first_name),
        phone_masked: this.maskPhone(r.referee?.phone),
      },
      ventes_generees: salesByReferee.get(r.referee_id) ?? 0,
      gains: gainsByReferee.get(r.referee_id) ?? 0,
    }));

    const ventes = [...salesByReferee.values()].reduce((s, v) => s + v, 0);
    const qualified = referrals.filter((r) => r.status === ReferralStatus.REWARDED).length;

    return {
      referral_code,
      filleuls,
      totals: {
        filleuls: referrals.length,
        qualified,
        ventes,
        gains_prime,
        gains_commission,
        solde_payable,
        deja_paye,
      },
    };
  }

  // ── Admin (back office) ───────────────────────────────────────────────────

  /** Liste des ambassadeurs avec un solde (PENDING/PAYABLE) ou déjà payé, triée par
   *  solde à verser décroissant. `over_threshold` = éligible au passage PAYABLE. */
  async adminListAmbassadors() {
    const { payout_threshold } = await this.getEarningConfig();

    const grouped = await this.prisma.referralEarning.groupBy({
      by: ['referrer_id', 'status'],
      _sum: { amount: true },
      where: { status: { not: ReferralEarningStatus.CANCELLED } },
    });

    const map = new Map<string, { pending: number; payable: number; paid: number }>();
    for (const g of grouped) {
      const acc = map.get(g.referrer_id) ?? { pending: 0, payable: 0, paid: 0 };
      const sum = g._sum.amount ?? 0;
      if (g.status === ReferralEarningStatus.PENDING) acc.pending += sum;
      else if (g.status === ReferralEarningStatus.PAYABLE) acc.payable += sum;
      else if (g.status === ReferralEarningStatus.PAID) acc.paid += sum;
      map.set(g.referrer_id, acc);
    }

    const ids = [...map.keys()];
    if (!ids.length) return { payout_threshold, ambassadors: [] as any[] };

    const customers = await this.prisma.customer.findMany({
      where: { id: { in: ids } },
      select: { id: true, first_name: true, last_name: true, phone: true, referral_code: true },
    });
    const byId = new Map(customers.map((c) => [c.id, c]));

    const ambassadors = ids
      .map((id) => {
        const a = map.get(id)!;
        const c = byId.get(id);
        const solde_payable = a.pending + a.payable;
        return {
          referrer_id: id,
          first_name: c?.first_name ?? null,
          last_name: c?.last_name ?? null,
          phone: c?.phone ?? null,
          referral_code: c?.referral_code ?? null,
          pending: a.pending,
          payable: a.payable,
          paid: a.paid,
          solde_payable,
          over_threshold: a.pending >= payout_threshold,
        };
      })
      .sort((x, y) => y.solde_payable - x.solde_payable);

    return { payout_threshold, ambassadors };
  }

  /** Passe des earnings PENDING→PAYABLE. Manuel : par `earning_ids` OU tout le PENDING
   *  d'un `referrer_id`. */
  async adminMarkPayable(dto: { earning_ids?: string[]; referrer_id?: string }) {
    if (dto.earning_ids?.length) {
      const r = await this.prisma.referralEarning.updateMany({
        where: { id: { in: dto.earning_ids }, status: ReferralEarningStatus.PENDING },
        data: { status: ReferralEarningStatus.PAYABLE, updated_at: new Date() },
      });
      return { updated: r.count };
    }
    if (dto.referrer_id) {
      const r = await this.prisma.referralEarning.updateMany({
        where: { referrer_id: dto.referrer_id, status: ReferralEarningStatus.PENDING },
        data: { status: ReferralEarningStatus.PAYABLE, updated_at: new Date() },
      });
      return { updated: r.count };
    }
    throw new BadRequestException('earning_ids ou referrer_id requis.');
  }

  /** Applique la RÈGLE DE SEUIL : passe PENDING→PAYABLE pour tout parrain dont le cumul
   *  PENDING atteint `payout_threshold`. À déclencher par une cadence back office. */
  async adminApplyPayoutThreshold() {
    const { payout_threshold } = await this.getEarningConfig();
    const grouped = await this.prisma.referralEarning.groupBy({
      by: ['referrer_id'],
      where: { status: ReferralEarningStatus.PENDING },
      _sum: { amount: true },
    });
    const eligible = grouped
      .filter((g) => (g._sum.amount ?? 0) >= payout_threshold)
      .map((g) => g.referrer_id);
    if (!eligible.length) return { promoted_referrers: 0, updated: 0 };

    const r = await this.prisma.referralEarning.updateMany({
      where: { referrer_id: { in: eligible }, status: ReferralEarningStatus.PENDING },
      data: { status: ReferralEarningStatus.PAYABLE, updated_at: new Date() },
    });
    return { promoted_referrers: eligible.length, updated: r.count };
  }

  /** Marque des earnings PAYABLE→PAID (versement effectué hors-système, V1). Trace
   *  paid_by (admin), paid_at, et une note optionnelle. */
  async adminMarkPaid(dto: { earning_ids: string[]; note?: string }, adminId: string) {
    if (!dto.earning_ids?.length) throw new BadRequestException('earning_ids requis.');
    const r = await this.prisma.referralEarning.updateMany({
      where: { id: { in: dto.earning_ids }, status: ReferralEarningStatus.PAYABLE },
      data: {
        status: ReferralEarningStatus.PAID,
        paid_by: adminId,
        paid_at: new Date(),
        ...(dto.note !== undefined ? { note: dto.note } : {}),
        updated_at: new Date(),
      },
    });
    return { paid: r.count };
  }

  /** Historique paginé des earnings (filtres : referrer_id, status). */
  async adminEarningsHistory(q: {
    referrer_id?: string;
    status?: ReferralEarningStatus;
    page?: number;
    limit?: number;
  }) {
    const page = q.page && q.page > 0 ? q.page : 1;
    const limit = Math.min(q.limit && q.limit > 0 ? q.limit : 20, 100);
    const where: Prisma.ReferralEarningWhereInput = {
      ...(q.referrer_id ? { referrer_id: q.referrer_id } : {}),
      ...(q.status ? { status: q.status } : {}),
    };
    const [data, total] = await this.prisma.$transaction([
      this.prisma.referralEarning.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.referralEarning.count({ where }),
    ]);
    return { data, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
  }

  /** Stats globales de parrainage (tous clients confondus). */
  async getGlobalStats() {
    const grouped = await this.prisma.referral.groupBy({ by: ['status'], _count: { _all: true } });
    const counts: Partial<Record<ReferralStatus, number>> = {};
    for (const g of grouped) counts[g.status] = g._count._all;
    const pending = counts[ReferralStatus.PENDING] ?? 0;
    const rewarded = counts[ReferralStatus.REWARDED] ?? 0;
    const cancelled = counts[ReferralStatus.CANCELLED] ?? 0;
    return { total: pending + rewarded + cancelled, pending, rewarded, cancelled };
  }

  /** Configuration courante du parrainage (réglages + défauts effectifs). Inclut le
   *  volet MONÉTAIRE (prime, commission, fenêtre, plafond, panier mini, seuil). */
  async getConfig() {
    const welcome_amount = await this.getWelcomeAmount();
    const parrain = await this.getParrainRewardConfig();
    const created_by = (await this.settingsService.get('reward.referral.created_by')) ?? null;
    const earning = await this.getEarningConfig();
    return { welcome_amount, parrain, created_by, ...earning };
  }

  /** Met à jour la configuration du parrainage (réglages). */
  async setConfig(dto: {
    welcome_amount?: number;
    parrain?: { type: RewardType; payload: Record<string, any>; expires_in_days?: number };
    created_by?: string | null;
    prime_amount?: number;
    commission_pct?: number;
    commission_window_days?: number;
    cap_per_referee?: number;
    min_qualifying_basket?: number;
    payout_threshold?: number;
  }) {
    if (dto.welcome_amount !== undefined) {
      if (!(dto.welcome_amount > 0)) {
        throw new BadRequestException('Le montant du bon de bienvenue doit être positif.');
      }
      await this.settingsService.set('reward.referral.welcome_amount', String(dto.welcome_amount));
    }
    if (dto.parrain !== undefined) {
      if (!dto.parrain.type || !dto.parrain.payload) {
        throw new BadRequestException('Récompense parrain invalide (type + payload requis).');
      }
      await this.settingsService.setJson('reward.referral.parrain', dto.parrain);
    }
    if (dto.created_by !== undefined) {
      if (dto.created_by) await this.settingsService.set('reward.referral.created_by', dto.created_by);
      else await this.settingsService.delete('reward.referral.created_by');
    }

    // ── Volet monétaire ──────────────────────────────────────────────────────
    if (dto.prime_amount !== undefined) {
      if (!(dto.prime_amount >= 0)) throw new BadRequestException('prime_amount doit être ≥ 0.');
      await this.settingsService.set('reward.referral.prime_amount', String(Math.round(dto.prime_amount)));
    }
    if (dto.commission_pct !== undefined) {
      if (!(dto.commission_pct >= 0 && dto.commission_pct <= 100)) {
        throw new BadRequestException('commission_pct doit être entre 0 et 100.');
      }
      await this.settingsService.set('reward.referral.commission_pct', String(dto.commission_pct));
    }
    if (dto.commission_window_days !== undefined) {
      if (!(dto.commission_window_days > 0)) {
        throw new BadRequestException('commission_window_days doit être > 0.');
      }
      await this.settingsService.set(
        'reward.referral.commission_window_days',
        String(Math.round(dto.commission_window_days)),
      );
    }
    if (dto.cap_per_referee !== undefined) {
      if (!(dto.cap_per_referee >= 0)) throw new BadRequestException('cap_per_referee doit être ≥ 0.');
      await this.settingsService.set('reward.referral.cap_per_referee', String(Math.round(dto.cap_per_referee)));
    }
    if (dto.min_qualifying_basket !== undefined) {
      if (!(dto.min_qualifying_basket >= 0)) {
        throw new BadRequestException('min_qualifying_basket doit être ≥ 0.');
      }
      await this.settingsService.set(
        'reward.referral.min_qualifying_basket',
        String(Math.round(dto.min_qualifying_basket)),
      );
    }
    if (dto.payout_threshold !== undefined) {
      if (!(dto.payout_threshold >= 0)) throw new BadRequestException('payout_threshold doit être ≥ 0.');
      await this.settingsService.set('reward.referral.payout_threshold', String(Math.round(dto.payout_threshold)));
    }

    return this.getConfig();
  }

  // ── Récompense du parrain (carte à gratter configurable) ──────────────────

  private async createParrainReward(referrerId: string) {
    const config = await this.getParrainRewardConfig();
    const payload: Record<string, any> = { ...config.payload };

    // VOUCHER : le bon est créé AU GRATTAGE et Voucher.created_by est NON nullable
    // → on injecte le créateur système dans le payload (lu par RewardService.scratchReward).
    if (config.type === RewardType.VOUCHER) {
      const creator = await this.resolveSystemCreatorId();
      if (!creator) {
        this.logger.warn('Parrainage : aucun créateur système → récompense VOUCHER parrain non créée.');
        return null;
      }
      payload.created_by = creator;
    }

    const expiresAt =
      config.expires_in_days && config.expires_in_days > 0
        ? new Date(Date.now() + config.expires_in_days * 24 * 60 * 60 * 1000)
        : null;

    return this.prisma.reward.create({
      data: {
        customer_id: referrerId,
        type: config.type,
        payload: payload as Prisma.InputJsonValue,
        reason: 'Parrainage — merci de nous avoir recommandés !',
        status: RewardStatus.PENDING,
        expires_at: expiresAt,
      },
    });
  }

  // ── Configuration (réglages) ──────────────────────────────────────────────

  private async getWelcomeAmount(): Promise<number> {
    const raw = await this.settingsService.get('reward.referral.welcome_amount');
    if (raw === null || raw.trim() === '') return 1000;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : 1000;
  }

  /** Réglages MONÉTAIRES du parrainage (défauts raisonnables — l'admin cale les vraies
   *  valeurs au back office). Montants en FCFA, pct en %, fenêtre/seuils en jours/FCFA. */
  async getEarningConfig(): Promise<{
    prime_amount: number;
    commission_pct: number;
    commission_window_days: number;
    cap_per_referee: number;
    min_qualifying_basket: number;
    payout_threshold: number;
  }> {
    return {
      prime_amount: await this.getNumberSetting('reward.referral.prime_amount', 1000),
      commission_pct: await this.getNumberSetting('reward.referral.commission_pct', 5),
      commission_window_days: await this.getNumberSetting('reward.referral.commission_window_days', 90),
      cap_per_referee: await this.getNumberSetting('reward.referral.cap_per_referee', 10000),
      min_qualifying_basket: await this.getNumberSetting('reward.referral.min_qualifying_basket', 3000),
      payout_threshold: await this.getNumberSetting('reward.referral.payout_threshold', 5000),
    };
  }

  private async getNumberSetting(key: string, def: number): Promise<number> {
    const raw = await this.settingsService.get(key);
    if (raw === null || raw.trim() === '') return def;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : def;
  }

  /** Masque RGPD du prénom filleul (1re lettre + ***). */
  private maskName(first?: string | null): string {
    const s = (first ?? '').trim();
    if (!s) return 'Filleul';
    return s.length <= 1 ? s : `${s[0]}***`;
  }

  /** Masque RGPD du téléphone filleul (2 derniers chiffres). */
  private maskPhone(phone?: string | null): string {
    const p = (phone ?? '').trim();
    if (p.length <= 2) return '****';
    return `****${p.slice(-2)}`;
  }

  private async getParrainRewardConfig(): Promise<{
    type: RewardType;
    payload: Record<string, any>;
    expires_in_days?: number;
  }> {
    const cfg = await this.settingsService.getJson<{
      type: RewardType;
      payload: Record<string, any>;
      expires_in_days?: number;
    }>('reward.referral.parrain');
    if (cfg && cfg.type && cfg.payload) return cfg;
    return { type: RewardType.VOUCHER, payload: { amount: 2000 } }; // défaut
  }

  /** Créateur des bons système : réglage `reward.referral.created_by`, sinon 1er User. */
  private async resolveSystemCreatorId(): Promise<string | null> {
    const configured = await this.settingsService.get('reward.referral.created_by');
    if (configured) {
      const u = await this.prisma.user.findUnique({ where: { id: configured }, select: { id: true } });
      if (u) return u.id;
    }
    const first = await this.prisma.user.findFirst({
      orderBy: { created_at: 'asc' },
      select: { id: true },
    });
    return first?.id ?? null;
  }

  /** Code alphanumérique SANS ambiguïté (ni 0/O/1/I) et non purement numérique
   *  (évite l'auto-cast du deep-link `?ref=`). Ex: CNABC23. */
  private generateCode(): string {
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < 6; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
    return `CN${s}`;
  }
}
