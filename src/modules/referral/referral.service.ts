import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  EntityStatus,
  NotificationTarget,
  NotificationType,
  Prisma,
  ReferralEarningStatus,
  ReferralEarningType,
  ReferralStatus,
  RewardStatus,
  RewardType,
  UserRole,
} from '@prisma/client';
import { notificationIcons } from 'src/modules/notifications/constantes/notifications.constante';
import { PrismaService } from 'src/database/services/prisma.service';
import { SettingsService } from 'src/modules/settings/settings.service';
import { VoucherService } from 'src/modules/voucher/voucher.service';
import { ExpoPushService } from 'src/expo-push/expo-push.service';
import { FILTRE_VENTE } from 'src/modules/statistics/helpers/statistics.helper';
import { coordonneesMasquees } from 'src/common/securite/masquer-contacts.interceptor';
import { codesPossibles, formeDeCarte, lireCodeChoisi, lireSaisie } from './referral-code.rules';

/** Client vu comme parrain au backoffice. */
const CLIENT_PARRAIN = {
  id: true,
  first_name: true,
  last_name: true,
  phone: true,
  referral_code: true,
  referral_code_ancien: true,
} satisfies Prisma.CustomerSelect;

type ClientParrain = Prisma.CustomerGetPayload<{ select: typeof CLIENT_PARRAIN }>;

const nomComplet = (c: { first_name?: string | null; last_name?: string | null } | null | undefined) =>
  [c?.first_name, c?.last_name].filter((p) => p && p.trim()).join(' ') || null;

const fcfa = (n: number) => `${n.toLocaleString('fr-FR')} FCFA`;

/** Les `n` éléments suivants d'une suite. */
function prendre<T>(suite: Iterator<T>, n: number): T[] {
  const lot: T[] = [];
  while (lot.length < n) {
    const suivant = suite.next();
    if (suivant.done) break;
    lot.push(suivant.value);
  }
  return lot;
}

/** Un cadeau possible (carte à gratter) : bon d'achat, plat offert… */
export interface ReferralGiftItem {
  type: RewardType;
  payload: Record<string, any>;
  expires_in_days?: number;
}

/**
 * Config d'un cadeau de parrainage (filleul OU parrain) :
 * - FIXED  : toujours le 1er item.
 * - RANDOM : un item tiré au hasard dans `items`.
 * Rétro-compat : l'ancien format { type, payload, expires_in_days? } est lu
 * comme { mode: 'FIXED', items: [ancien] }.
 */
export interface ReferralGiftConfig {
  mode: 'FIXED' | 'RANDOM';
  items: ReferralGiftItem[];
}

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
    private readonly expoPushService: ExpoPushService,
  ) {}

  /** Code de parrainage du client (attribué à la 1ère demande, unique). */
  async getOrCreateReferralCode(customerId: string): Promise<string> {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { referral_code: true, first_name: true, last_name: true, phone: true },
    });
    if (!customer) throw new NotFoundException('Client introuvable.');
    if (customer.referral_code) return customer.referral_code;
    return this.attribuerCode(customerId, customer);
  }

  /**
   * Donne au client le premier code libre : CN-PRENOM, CN-NOM, puis CN-PRENOM2…
   * (referral-code.rules.ts). Un code posé entre-temps par un autre écran est
   * gardé ; un code pris à l'instant par un autre client fait relire le lot.
   */
  private async attribuerCode(
    customerId: string,
    client: { first_name?: string | null; last_name?: string | null; phone?: string | null },
  ): Promise<string> {
    const suite = codesPossibles(client);
    let lot = prendre(suite, 50);
    for (let essai = 0; essai < 25 && lot.length; essai++) {
      const code = await this.premierCodeLibre(lot);
      if (!code) {
        lot = prendre(suite, 50);
        continue;
      }
      try {
        const pose = await this.prisma.customer.updateMany({
          where: { id: customerId, referral_code: null },
          data: { referral_code: code },
        });
        if (pose.count === 1) return code;
        const actuel = await this.prisma.customer.findUnique({
          where: { id: customerId },
          select: { referral_code: true },
        });
        if (actuel?.referral_code) return actuel.referral_code;
        throw new NotFoundException('Client introuvable.');
      } catch (e: any) {
        if (e?.code !== 'P2002') throw e;
      }
    }
    throw new BadRequestException('Impossible de générer un code de parrainage, réessayez.');
  }

  /**
   * Premier code de la liste que personne ne porte : ni un autre parrain (code
   * actuel, ou ancien code qui s'écrit pareil sans le tiret), ni un code promo,
   * et qui n'a pas la forme d'un numéro de carte.
   */
  private async premierCodeLibre(candidats: string[], saufClientId?: string): Promise<string | null> {
    const possibles = candidats.filter((c) => !formeDeCarte(c));
    if (!possibles.length) return null;
    const autre: Prisma.CustomerWhereInput = saufClientId ? { id: { not: saufClientId } } : {};
    const [codes, anciens, promos] = await Promise.all([
      this.prisma.customer.findMany({
        where: { referral_code: { in: possibles }, ...autre },
        select: { referral_code: true },
      }),
      this.prisma.customer.findMany({
        where: { referral_code_ancien: { in: possibles.map((c) => c.replace('-', '')) }, ...autre },
        select: { referral_code_ancien: true },
      }),
      this.prisma.promoCode.findMany({ where: { code: { in: possibles } }, select: { code: true } }),
    ]);
    const pris = new Set<string>([
      ...codes.map((c) => c.referral_code ?? ''),
      ...anciens.map((c) => `CN-${(c.referral_code_ancien ?? '').slice(2)}`),
      ...promos.map((p) => p.code),
    ]);
    return possibles.find((c) => !pris.has(c)) ?? null;
  }

  /**
   * Parrain d'un code saisi par le client : « cn-awa », « CNAWA » ou « awa »
   * trouvent `CN-AWA`, et un code d'avant le 03/11 (`CNABC23`) reste valable.
   */
  private async trouverParrainParCode(saisie: string) {
    const { nouveaux, ancien } = lireSaisie(saisie);
    if (!ancien) return null;
    const trouves = await this.prisma.customer.findMany({
      where: { OR: [{ referral_code: { in: nouveaux } }, { referral_code_ancien: ancien }] },
      select: { id: true, referral_code: true, referral_code_ancien: true },
    });
    for (const code of nouveaux) {
      const c = trouves.find((t) => t.referral_code === code);
      if (c) return { id: c.id, code };
    }
    const c = trouves.find((t) => t.referral_code_ancien === ancien);
    return c ? { id: c.id, code: ancien } : null;
  }

  /**
   * Applique un code de parrainage pour le filleul connecté (à l'inscription) :
   * crée le lien Referral (PENDING) et crédite le bon de bienvenue du filleul.
   * Anti-abus : pas d'auto-parrainage, filleul jamais déjà parrainé, filleul
   * NOUVEAU client (aucune commande payée).
   */
  async applyReferralCode(refereeId: string, rawCode: string) {
    if (!(rawCode ?? '').trim()) throw new BadRequestException('Code de parrainage requis.');

    const already = await this.prisma.referral.findUnique({ where: { referee_id: refereeId } });
    if (already) throw new BadRequestException('Vous avez déjà utilisé un code de parrainage.');

    const referrer = await this.trouverParrainParCode(rawCode);
    if (!referrer) throw new BadRequestException('Code de parrainage invalide.');
    const code = referrer.code;
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

    // Cadeau à GRATTER du filleul (non bloquant : on ne casse pas l'inscription).
    // C'est l'utilisation de CE cadeau sur une commande qui récompensera le parrain.
    try {
      const cfg = await this.getFilleulGiftConfig();
      const reward = await this.createGiftReward(
        refereeId,
        cfg,
        'Cadeau de bienvenue du parrainage 🎁',
      );
      if (reward) {
        await this.prisma.referral.update({
          where: { id: referral.id },
          data: { filleul_reward_id: reward.id },
        });
        void this.pushToCustomer(
          refereeId,
          '🎁 Un cadeau t\'attend !',
          'Bienvenue chez Chicken Nation ! Gratte ta carte cadeau dans l\'app et utilise-la sur ta première commande.',
        );
        void this.notifyFilleulMerged(refereeId);
      }
    } catch (e: any) {
      this.logger.warn(`Cadeau filleul parrainage échoué (${refereeId}): ${e?.message}`);
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

    // DÉCISION 30/07 : le parrain ne reçoit PLUS de bon/carte à gratter à la
    // qualification — sa récompense est UNIQUEMENT monétaire (PRIME ambassadeur
    // + commissions, créditées par accrueForPaidOrder juste après). L'ancienne
    // carte à gratter parrain (`reward.referral.parrain`) est débranchée ;
    // `parrain_reward_id` reste en base pour l'historique des parrainages
    // antérieurs. Le cadeau du FILLEUL, lui, ne change pas.
    this.logger.log(`Parrainage qualifié (filleul ${refereeId}) → prime ambassadeur au parrain.`);
    return true;
  }

  /**
   * Le filleul a-t-il UTILISÉ son cadeau de parrainage sur CETTE commande ?
   * C'est le déclencheur de la récompense parrain (remplace « 1ère commande payée »).
   *  - Cadeau VOUCHER : le bon créé au grattage (payload.voucher_id) a une
   *    Redemption sur la commande.
   *  - Cadeau GIFT (plat offert) : le Reward est CONSUMED sur la commande.
   *  - Cadeau non créé / autre type : fallback = 1ère commande payée (ancienne règle).
   *  - Referral legacy (bon direct, pas de filleul_reward_id) : ancienne règle.
   */
  private async giftUsedOnOrder(
    referral: { filleul_reward_id: string | null },
    orderId: string,
  ): Promise<boolean> {
    if (!referral.filleul_reward_id) return true; // legacy → ancienne règle

    const reward = await this.prisma.reward.findUnique({
      where: { id: referral.filleul_reward_id },
      select: { id: true, type: true, status: true, payload: true, order_id: true },
    });
    if (!reward) return true; // cadeau disparu → ne pas bloquer la qualification

    if (reward.type === RewardType.GIFT) {
      return reward.order_id === orderId && reward.status === RewardStatus.CONSUMED;
    }

    const voucherId = (reward.payload as Record<string, any> | null)?.voucher_id as
      | string
      | undefined;
    if (voucherId) {
      const redemption = await this.prisma.redemption.findFirst({
        // Une utilisation rendue (commande annulée) ne compte pas.
        where: { voucher_id: voucherId, order_id: orderId, entity_status: 'ACTIVE' },
        select: { id: true },
      });
      return !!redemption;
    }

    // VOUCHER pas encore gratté (pas de bon émis) → cadeau pas utilisé.
    if (reward.type === RewardType.VOUCHER && reward.status === RewardStatus.PENDING) {
      return false;
    }
    // Types sans traçage d'usage (ex. POINTS) : gratté = considéré utilisé.
    return reward.status !== RewardStatus.PENDING;
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

    // 0) Déclencheur v2 : tant que le filleul n'a pas UTILISÉ son cadeau sur une
    //    commande, pas de qualification (le parrain attend). Les commandes payées
    //    sans le cadeau ne comptent pas.
    if (referral.status === ReferralStatus.PENDING) {
      const used = await this.giftUsedOnOrder(referral, orderId);
      if (!used) {
        this.logger.log(
          `Parrainage : commande ${orderId} payée SANS le cadeau du filleul ${refereeId} → qualification différée.`,
        );
        return;
      }
    }

    // 1) Qualification (claim atomique) + carte à gratter parrain existante.
    const justQualified = await this.qualifyReferralForPaidOrder(refereeId, orderId);

    const config = await this.getEarningConfig();

    if (justQualified) {
      // 2) PRIME — seule la commande qualifiante y donne droit (RG-11 : panier mini).
      if (netAmount >= config.min_qualifying_basket && config.prime_amount > 0) {
        const credite = await this.createEarning({
          referral,
          refereeId,
          orderId,
          type: ReferralEarningType.PRIME,
          rawAmount: config.prime_amount,
          cap: config.cap_per_referee,
        });
        // Notification parrain : la récompense est désormais UNIQUEMENT la
        // prime — on annonce le montant réellement crédité (plafond déduit).
        if (credite > 0) {
          void this.pushToCustomer(
            referral.referrer_id,
            '💛 Ton filleul a utilisé son cadeau !',
            `Ta prime ambassadeur de ${credite.toLocaleString('fr-FR')} F est créditée. Retrouve-la dans « Inviter un ami ».`,
          );
          void this.notifyInApp(
            referral.referrer_id,
            '💛 Ton filleul a utilisé son cadeau !',
            `Ta prime ambassadeur de ${credite.toLocaleString('fr-FR')} F est créditée.`,
          );
        }
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
  }): Promise<number> {
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
        return 0;
      }
      amount = Math.min(amount, remaining);
    }

    if (amount <= 0) return 0;

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
      return amount;
    } catch (e: any) {
      if (e?.code === 'P2002') return 0; // déjà comptabilisé pour cette commande + type
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

  /**
   * Tableau de bord ambassadeur au CONTRAT DE L'APP MOBILE (écran Phase 5) :
   * réglages effectifs, agrégats nommés côté app, filleuls masqués enrichis
   * (commandes, fenêtre de commission, plafonnement) et versements (V1 : vide,
   * versement manuel non historisé par client).
   */
  async getAmbassadorDashboardForApp(customerId: string) {
    const [wallet, config] = await Promise.all([
      this.getAmbassadorDashboard(customerId),
      this.getEarningConfig(),
    ]);

    const referrals = await this.prisma.referral.findMany({
      where: { referrer_id: customerId },
      select: {
        id: true,
        referee_id: true,
        status: true,
        created_at: true,
        qualified_at: true,
        referee: { select: { first_name: true, phone: true } },
      },
      orderBy: { created_at: 'desc' },
    });
    const refereeIds = referrals.map((r) => r.referee_id);

    // Commandes payées (nb + CA) et gains par filleul et par type.
    const ordersByReferee = new Map<string, { count: number; sales: number }>();
    const primeByReferee = new Map<string, number>();
    const commissionByReferee = new Map<string, number>();
    if (refereeIds.length) {
      const orders = await this.prisma.order.groupBy({
        by: ['customer_id'],
        where: { customer_id: { in: refereeIds }, paied: true },
        _count: { _all: true },
        _sum: { net_amount: true },
      });
      for (const o of orders) {
        ordersByReferee.set(o.customer_id, {
          count: o._count._all,
          sales: o._sum.net_amount ?? 0,
        });
      }

      const earnings = await this.prisma.referralEarning.groupBy({
        by: ['referee_id', 'type'],
        where: {
          referrer_id: customerId,
          status: { not: ReferralEarningStatus.CANCELLED },
        },
        _sum: { amount: true },
      });
      for (const e of earnings) {
        const target =
          e.type === ReferralEarningType.PRIME ? primeByReferee : commissionByReferee;
        target.set(e.referee_id, (target.get(e.referee_id) ?? 0) + (e._sum.amount ?? 0));
      }
    }

    const windowMs = config.commission_window_days * 24 * 60 * 60 * 1000;

    const referees = referrals.map((r) => {
      const prime = primeByReferee.get(r.referee_id) ?? 0;
      const commission = commissionByReferee.get(r.referee_id) ?? 0;
      const total = prime + commission;
      const orders = ordersByReferee.get(r.referee_id);
      return {
        id: r.id,
        masked_name: `${this.maskName(r.referee?.first_name)} (${this.maskPhone(r.referee?.phone)})`,
        status: r.status === ReferralStatus.REWARDED ? 'QUALIFIED' : 'PENDING',
        joined_at: r.created_at,
        qualified_at: r.qualified_at,
        commission_window_ends_at: r.qualified_at
          ? new Date(r.qualified_at.getTime() + windowMs)
          : null,
        orders_count: orders?.count ?? 0,
        sales_generated: orders?.sales ?? 0,
        earned_prime: prime,
        earned_commission: commission,
        earned_total: total,
        capped: config.cap_per_referee > 0 && total >= config.cap_per_referee,
      };
    });

    return {
      referral_code: wallet.referral_code,
      currency: 'FCFA',
      config: {
        prime_amount: config.prime_amount,
        min_basket: config.min_qualifying_basket,
        commission_rate: config.commission_pct / 100,
        commission_window_days: config.commission_window_days,
        per_referee_cap: config.cap_per_referee,
      },
      totals: {
        referred_count: wallet.totals.filleuls,
        qualified_count: wallet.totals.qualified,
        pending_count: wallet.totals.filleuls - wallet.totals.qualified,
        sales_generated: wallet.totals.ventes,
        earned_total: wallet.totals.gains_prime + wallet.totals.gains_commission,
        earned_prime: wallet.totals.gains_prime,
        earned_commission: wallet.totals.gains_commission,
        payable_balance: wallet.totals.solde_payable,
        paid_total: wallet.totals.deja_paye,
      },
      referees,
      payouts: [] as any[], // V1 : versements manuels, pas d'historique par client
    };
  }

  // ── Admin (back office) ───────────────────────────────────────────────────

  /**
   * Tous les parrains : chaque client qui a un code, ceux qui ont le plus de
   * filleuls en tête. Recherche par nom, code ou téléphone (pas par téléphone
   * pour un rôle qui reçoit les numéros masqués : la réponse dirait quels
   * chiffres figurent dans un numéro caché).
   *
   * L'ancienne liste ne montrait que les parrains déjà rémunérés, sous une
   * forme que l'écran ne lisait pas : elle restait vide (03/11).
   */
  async adminListAmbassadors(
    q: { page?: number; limit?: number; search?: string },
    role?: UserRole | null,
  ) {
    const page = Math.max(1, Math.floor(Number(q.page) || 1));
    const limit = Math.min(Math.max(1, Math.floor(Number(q.limit) || 10)), 50);
    const where: Prisma.CustomerWhereInput = {
      referral_code: { not: null },
      entity_status: { not: EntityStatus.DELETED },
      ...this.filtreRecherche(q.search, role),
    };
    const [clients, total, { payout_threshold }] = await Promise.all([
      this.prisma.customer.findMany({
        where,
        orderBy: [{ referrals_made: { _count: 'desc' } }, { created_at: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: CLIENT_PARRAIN,
      }),
      this.prisma.customer.count({ where }),
      this.getEarningConfig(),
    ]);
    return {
      items: await this.lignesParrains(clients),
      total,
      page,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      payout_threshold,
    };
  }

  /** Recherche d'un client par nom (chaque mot), code ou téléphone. */
  private filtreRecherche(search: string | undefined, role?: UserRole | null): Prisma.CustomerWhereInput {
    const s = (search ?? '').trim();
    if (!s) return {};
    const mots = s.split(/\s+/).filter(Boolean);
    const ou: Prisma.CustomerWhereInput[] = [
      {
        AND: mots.map((m) => ({
          OR: [
            { first_name: { contains: m, mode: 'insensitive' as const } },
            { last_name: { contains: m, mode: 'insensitive' as const } },
          ],
        })),
      },
    ];
    // « CN AWA », « cn-awa » ou « awa » : le morceau après CN-.
    const { nouveaux, ancien } = lireSaisie(s);
    const morceau = nouveaux[0]?.slice(3);
    if (morceau) ou.push({ referral_code: { contains: morceau, mode: 'insensitive' } });
    if (ancien.length >= 3) ou.push({ referral_code_ancien: { contains: ancien } });
    const chiffres = s.replace(/\D/g, '');
    if (chiffres.length >= 3 && !coordonneesMasquees(role)) ou.push({ phone: { contains: chiffres } });
    return { OR: ou };
  }

  /** Chiffres d'une page de parrains : filleuls, ventes générées, gains par état. */
  private async lignesParrains(clients: ClientParrain[]) {
    const ids = clients.map((c) => c.id);
    if (!ids.length) return [];
    const [parrainages, gains] = await Promise.all([
      this.prisma.referral.findMany({
        where: { referrer_id: { in: ids }, status: { not: ReferralStatus.CANCELLED } },
        select: { referrer_id: true, referee_id: true, status: true },
      }),
      this.prisma.referralEarning.groupBy({
        by: ['referrer_id', 'status'],
        where: { referrer_id: { in: ids } },
        _sum: { amount: true },
      }),
    ]);
    const ventes = await this.ventesParClient(parrainages.map((p) => p.referee_id));

    return clients.map((c) => {
      const siens = parrainages.filter((p) => p.referrer_id === c.id);
      const somme = (statut: ReferralEarningStatus) =>
        gains.find((g) => g.referrer_id === c.id && g.status === statut)?._sum.amount ?? 0;
      const pending = somme(ReferralEarningStatus.PENDING);
      const payable = somme(ReferralEarningStatus.PAYABLE);
      const paid = somme(ReferralEarningStatus.PAID);
      return {
        customer_id: c.id,
        fullname: nomComplet(c),
        phone: c.phone,
        referral_code: c.referral_code,
        referral_code_ancien: c.referral_code_ancien,
        referees_count: siens.length,
        qualified_referees_count: siens.filter((p) => p.status === ReferralStatus.REWARDED).length,
        generated_sales: siens.reduce((t, p) => t + (ventes.get(p.referee_id)?.montant ?? 0), 0),
        total_earned: pending + payable + paid,
        pending_amount: pending,
        payable_amount: payable,
        paid_amount: paid,
      };
    });
  }

  /** Ventes des clients (même règle que les statistiques : FILTRE_VENTE). */
  private async ventesParClient(ids: string[]) {
    const ventes = new Map<string, { montant: number; commandes: number }>();
    if (!ids.length) return ventes;
    const groupes = await this.prisma.order.groupBy({
      by: ['customer_id'],
      where: { customer_id: { in: ids }, ...FILTRE_VENTE },
      _sum: { net_amount: true },
      _count: { _all: true },
    });
    for (const g of groupes) {
      ventes.set(g.customer_id, { montant: g._sum.net_amount ?? 0, commandes: g._count._all });
    }
    return ventes;
  }

  /** Fiche d'un parrain : chiffres, filleuls, gains et versements. */
  async adminAmbassadorDetail(customerId: string) {
    const client = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: CLIENT_PARRAIN,
    });
    if (!client) throw new NotFoundException('Client introuvable.');

    const [[ligne], parrainages, gains] = await Promise.all([
      this.lignesParrains([client]),
      this.prisma.referral.findMany({
        where: { referrer_id: customerId },
        orderBy: { created_at: 'desc' },
        select: {
          id: true,
          status: true,
          created_at: true,
          qualified_at: true,
          referee: { select: { id: true, first_name: true, last_name: true, phone: true } },
        },
      }),
      this.prisma.referralEarning.findMany({
        where: { referrer_id: customerId },
        orderBy: { created_at: 'desc' },
      }),
    ]);

    const idsCommandes = gains.map((g) => g.source_order_id).filter((id): id is string => !!id);
    const idsVerseurs = [...new Set(gains.map((g) => g.paid_by).filter((id): id is string => !!id))];
    const [ventes, commandes, verseurs] = await Promise.all([
      this.ventesParClient(parrainages.map((p) => p.referee.id)),
      this.prisma.order.findMany({
        where: { id: { in: idsCommandes } },
        select: { id: true, reference: true, net_amount: true },
      }),
      this.prisma.user.findMany({ where: { id: { in: idsVerseurs } }, select: { id: true, fullname: true } }),
    ]);
    const nomFilleul = new Map(parrainages.map((p) => [p.referee.id, nomComplet(p.referee)]));

    // Un versement = les gains soldés ensemble : même date, même auteur, même note.
    const versements = new Map<string, { paid_at: Date; paid_by: string | null; note: string | null; amount: number }>();
    for (const g of gains) {
      if (g.status !== ReferralEarningStatus.PAID || !g.paid_at) continue;
      const cle = `${g.paid_at.toISOString()}|${g.paid_by ?? ''}|${g.note ?? ''}`;
      const v = versements.get(cle) ?? { paid_at: g.paid_at, paid_by: g.paid_by, note: g.note, amount: 0 };
      v.amount += g.amount;
      versements.set(cle, v);
    }

    return {
      ...ligne,
      filleuls: parrainages.map((p) => ({
        id: p.id,
        customer_id: p.referee.id,
        fullname: nomComplet(p.referee),
        phone: p.referee.phone,
        status: p.status,
        joined_at: p.created_at,
        qualified_at: p.qualified_at,
        sales: ventes.get(p.referee.id)?.montant ?? 0,
        orders_count: ventes.get(p.referee.id)?.commandes ?? 0,
      })),
      earnings: gains.map((g) => {
        const commande = commandes.find((c) => c.id === g.source_order_id);
        return {
          id: g.id,
          kind: g.type,
          status: g.status,
          amount: g.amount,
          referee_id: g.referee_id,
          referee_name: nomFilleul.get(g.referee_id) ?? null,
          order_id: g.source_order_id,
          order_number: commande?.reference ?? null,
          order_amount: commande?.net_amount ?? null,
          created_at: g.created_at,
        };
      }),
      payouts: [...versements.values()]
        .sort((a, b) => b.paid_at.getTime() - a.paid_at.getTime())
        .map((v) => ({
          id: v.paid_at.toISOString(),
          ambassador_id: customerId,
          amount: v.amount,
          note: v.note,
          paid_by: v.paid_by,
          paid_by_name: verseurs.find((u) => u.id === v.paid_by)?.fullname ?? null,
          created_at: v.paid_at,
        })),
    };
  }

  /** Fait d'un client un parrain : code choisi, sinon CN-PRENOM. */
  async adminCreerParrain(dto: { customer_id: string; code?: string }) {
    const client = await this.prisma.customer.findUnique({
      where: { id: dto.customer_id },
      select: { referral_code: true, first_name: true, last_name: true, phone: true },
    });
    if (!client) throw new NotFoundException('Client introuvable.');
    if (client.referral_code) {
      throw new BadRequestException(`Ce client est déjà parrain, avec le code ${client.referral_code}.`);
    }
    if (dto.code?.trim()) await this.poserCode(dto.customer_id, dto.code);
    else await this.attribuerCode(dto.customer_id, client);
    return this.adminAmbassadorDetail(dto.customer_id);
  }

  /** Change le code d'un parrain. L'ancien cesse de marcher, sauf le code d'avant le 03/11. */
  async adminChangerCode(customerId: string, saisie: string) {
    await this.poserCode(customerId, saisie);
    return this.adminAmbassadorDetail(customerId);
  }

  private async poserCode(customerId: string, saisie: string) {
    const lu = lireCodeChoisi(saisie);
    if ('erreur' in lu) throw new BadRequestException(lu.erreur);
    const client = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: { referral_code: true },
    });
    if (!client) throw new NotFoundException('Client introuvable.');
    if (client.referral_code === lu.code) return;
    const pris = new BadRequestException(`Le code ${lu.code} est déjà pris. Choisissez-en un autre.`);
    if (!(await this.premierCodeLibre([lu.code], customerId))) throw pris;
    try {
      await this.prisma.customer.update({ where: { id: customerId }, data: { referral_code: lu.code } });
    } catch (e: any) {
      if (e?.code === 'P2002') throw pris;
      throw e;
    }
  }

  /**
   * Rattache un filleul qui a oublié le code à l'inscription. Mêmes règles que
   * dans l'application : nouveau client, jamais parrainé. Il reçoit son cadeau.
   */
  async adminRattacherFilleul(parrainId: string, filleulId: string) {
    if (parrainId === filleulId) {
      throw new BadRequestException('Un client ne peut pas être son propre filleul.');
    }
    const [filleul, dejaParraine, commandePayee] = await Promise.all([
      this.prisma.customer.findUnique({ where: { id: filleulId }, select: { id: true } }),
      this.prisma.referral.findUnique({ where: { referee_id: filleulId }, select: { referral_code: true } }),
      this.prisma.order.findFirst({ where: { customer_id: filleulId, paied: true }, select: { id: true } }),
    ]);
    if (!filleul) throw new NotFoundException('Client introuvable.');
    if (dejaParraine) {
      throw new BadRequestException(`Ce client est déjà filleul (code ${dejaParraine.referral_code}).`);
    }
    if (commandePayee) {
      throw new BadRequestException(
        'Ce client a déjà une commande payée : le parrainage est réservé aux nouveaux clients.',
      );
    }
    const code = await this.getOrCreateReferralCode(parrainId);
    await this.applyReferralCode(filleulId, code);
    return this.adminAmbassadorDetail(parrainId);
  }

  /**
   * Annule un parrainage (fraude, erreur) : plus de prime ni de commission pour
   * ce filleul, les gains non versés sont annulés. Un gain déjà versé reste.
   * Le filleul ne peut plus être rattaché à un autre parrain.
   */
  async adminAnnulerParrainage(referralId: string) {
    const parrainage = await this.prisma.referral.findUnique({
      where: { id: referralId },
      select: { id: true, referrer_id: true, status: true },
    });
    if (!parrainage) throw new NotFoundException('Parrainage introuvable.');
    if (parrainage.status !== ReferralStatus.CANCELLED) {
      const maintenant = new Date();
      await this.prisma.$transaction([
        this.prisma.referral.update({
          where: { id: referralId },
          data: { status: ReferralStatus.CANCELLED, updated_at: maintenant },
        }),
        this.prisma.referralEarning.updateMany({
          where: {
            referral_id: referralId,
            status: { in: [ReferralEarningStatus.PENDING, ReferralEarningStatus.PAYABLE] },
          },
          data: {
            status: ReferralEarningStatus.CANCELLED,
            note: 'Parrainage annulé au backoffice',
            updated_at: maintenant,
          },
        }),
      ]);
    }
    return this.adminAmbassadorDetail(parrainage.referrer_id);
  }

  /** « Passer en payable » : tous les gains en attente du parrain. */
  async adminPasserPayable(customerId: string) {
    await this.adminMarkPayable({ referrer_id: customerId });
    return this.adminAmbassadorDetail(customerId);
  }

  /**
   * « Marquer payé » : solde tout le payable du parrain, versé hors du système
   * (Wave, espèces). Le montant envoyé doit être ce solde : un écran resté
   * ouvert pendant qu'un gain changeait ne verse pas un autre montant.
   */
  async adminVerser(customerId: string, dto: { amount: number; note?: string }, adminId: string) {
    const dus = await this.prisma.referralEarning.findMany({
      where: { referrer_id: customerId, status: ReferralEarningStatus.PAYABLE },
      select: { id: true, amount: true },
    });
    const solde = dus.reduce((t, g) => t + g.amount, 0);
    if (solde <= 0) throw new BadRequestException('Aucun gain payable à verser.');
    if (Math.round(Number(dto.amount)) !== solde) {
      throw new BadRequestException(`Le solde payable est de ${fcfa(solde)}. Rechargez la fiche.`);
    }
    const paidAt = new Date();
    const note = dto.note?.trim() || null;
    await this.prisma.referralEarning.updateMany({
      where: { id: { in: dus.map((g) => g.id) }, status: ReferralEarningStatus.PAYABLE },
      data: { status: ReferralEarningStatus.PAID, paid_by: adminId, paid_at: paidAt, note, updated_at: paidAt },
    });
    const verse = await this.prisma.referralEarning.aggregate({
      where: { referrer_id: customerId, status: ReferralEarningStatus.PAID, paid_at: paidAt },
      _sum: { amount: true },
    });
    const auteur = await this.prisma.user.findUnique({ where: { id: adminId }, select: { fullname: true } });
    return {
      id: paidAt.toISOString(),
      ambassador_id: customerId,
      amount: verse._sum.amount ?? 0,
      note,
      paid_by: adminId,
      paid_by_name: auteur?.fullname ?? null,
      created_at: paidAt,
    };
  }

  /**
   * Clients proposés pour devenir parrain ou filleul, avec ce qui empêcherait
   * de les choisir : déjà parrain, déjà filleul, déjà une commande payée.
   */
  async adminChercherClients(search: string | undefined, role?: UserRole | null) {
    if ((search ?? '').trim().length < 2) return [];
    const clients = await this.prisma.customer.findMany({
      where: { entity_status: { not: EntityStatus.DELETED }, ...this.filtreRecherche(search, role) },
      orderBy: { created_at: 'desc' },
      take: 8,
      select: {
        id: true,
        first_name: true,
        last_name: true,
        phone: true,
        referral_code: true,
        referral_received: { select: { referral_code: true } },
      },
    });
    const payees = clients.length
      ? await this.prisma.order.groupBy({
          by: ['customer_id'],
          where: { customer_id: { in: clients.map((c) => c.id) }, paied: true },
          _count: { _all: true },
        })
      : [];
    return clients.map((c) => ({
      customer_id: c.id,
      fullname: nomComplet(c),
      phone: c.phone,
      referral_code: c.referral_code,
      sponsor_code: c.referral_received?.referral_code ?? null,
      has_paid_order: payees.some((p) => p.customer_id === c.id),
    }));
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
    const parrain = await this.getParrainGiftConfig();
    const filleul = await this.getFilleulGiftConfig();
    const created_by = (await this.settingsService.get('reward.referral.created_by')) ?? null;
    const earning = await this.getEarningConfig();
    return { welcome_amount, parrain, filleul, created_by, ...earning };
  }

  /** Met à jour la configuration du parrainage (réglages). */
  async setConfig(dto: {
    welcome_amount?: number;
    parrain?: any;
    filleul?: any;
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
      const normalized = this.normalizeGiftConfig(dto.parrain);
      if (!normalized) {
        throw new BadRequestException(
          'Cadeau parrain invalide ({ mode, items[] } ou { type, payload }).',
        );
      }
      const enriched = await this.enrichGiftItems(normalized);
      await this.settingsService.setJson('reward.referral.parrain', enriched);
    }
    if (dto.filleul !== undefined) {
      const normalized = this.normalizeGiftConfig(dto.filleul);
      if (!normalized) {
        throw new BadRequestException(
          'Cadeau filleul invalide ({ mode, items[] } ou { type, payload }).',
        );
      }
      const enriched = await this.enrichGiftItems(normalized);
      await this.settingsService.setJson('reward.referral.filleul', enriched);
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

  // ── Cadeaux à gratter configurables (filleul & parrain) ───────────────────

  /**
   * Crée un cadeau à gratter (Reward PENDING) selon la config : mode FIXED = le
   * 1er item, mode RANDOM = tirage au sort. VOUCHER → injecte le créateur système
   * (le bon est créé AU GRATTAGE, `Voucher.created_by` non nullable).
   */
  private async createGiftReward(
    customerId: string,
    cfg: ReferralGiftConfig,
    reason: string,
  ) {
    const item = this.pickGiftItem(cfg);
    if (!item) {
      this.logger.warn('Parrainage : config cadeau vide → aucun cadeau créé.');
      return null;
    }
    const payload: Record<string, any> = { ...item.payload };

    if (item.type === RewardType.VOUCHER) {
      const creator = await this.resolveSystemCreatorId();
      if (!creator) {
        this.logger.warn('Parrainage : aucun créateur système → cadeau VOUCHER non créé.');
        return null;
      }
      payload.created_by = creator;
    }

    const expiresAt =
      item.expires_in_days && item.expires_in_days > 0
        ? new Date(Date.now() + item.expires_in_days * 24 * 60 * 60 * 1000)
        : null;

    return this.prisma.reward.create({
      data: {
        customer_id: customerId,
        type: item.type,
        payload: payload as Prisma.InputJsonValue,
        reason,
        status: RewardStatus.PENDING,
        expires_at: expiresAt,
      },
    });
  }

  /** FIXED → 1er item ; RANDOM → tirage uniforme. */
  private pickGiftItem(cfg: ReferralGiftConfig): ReferralGiftItem | null {
    const items = (cfg.items ?? []).filter((i) => i && i.type && i.payload);
    if (items.length === 0) return null;
    if (cfg.mode === 'RANDOM' && items.length > 1) {
      return items[Math.floor(Math.random() * items.length)];
    }
    return items[0];
  }

  /**
   * FUSION des messages de bienvenue du filleul : remplace le « 🎉 Bienvenue »
   * générique (créé quelques secondes plus tôt à la création du compte) par UN
   * SEUL message bienvenue + cadeau — pas deux notifications côte à côte.
   */
  private async notifyFilleulMerged(customerId: string) {
    try {
      await this.prisma.notification.deleteMany({
        where: {
          user_id: customerId,
          target: NotificationTarget.CUSTOMER,
          title: { startsWith: '🎉 Bienvenue' },
          created_at: { gte: new Date(Date.now() - 60 * 60 * 1000) },
        },
      });
    } catch {
      // Non bloquant : au pire, deux notifs.
    }
    await this.notifyInApp(
      customerId,
      '🎉 Bienvenue ! Un cadeau t\'attend',
      'Ton compte est prêt et ton code de parrainage est validé : gratte ta carte cadeau et utilise-la sur ta première commande.',
    );
  }

  /**
   * Notification IN-APP (cloche du client) non bloquante — visible même sans
   * push (simulateur, permissions refusées, token pas encore enregistré).
   */
  private async notifyInApp(customerId: string, title: string, message: string) {
    try {
      await this.prisma.notification.create({
        data: {
          title,
          message,
          type: NotificationType.PROMOTION,
          user_id: customerId,
          target: NotificationTarget.CUSTOMER,
          icon: notificationIcons.joice.url,
          icon_bg_color: notificationIcons.joice.color,
          show_chevron: false,
          data: { kind: 'referral' },
        },
      });
    } catch (e: any) {
      this.logger.warn(`Notif in-app parrainage échouée (${customerId}): ${e?.message}`);
    }
  }

  /** Push non bloquant vers un client (token Expo depuis ses réglages notifs). */
  private async pushToCustomer(customerId: string, title: string, body: string) {
    try {
      const settings = await this.prisma.notificationSetting.findUnique({
        where: { customer_id: customerId },
        select: { expo_push_token: true, push: true, active: true },
      });
      const token = settings?.expo_push_token;
      if (!token || settings?.push === false || settings?.active === false) return;
      await this.expoPushService.sendPushNotifications({
        tokens: [token],
        title,
        body,
        data: { type: 'referral' },
        sound: 'default',
        priority: 'high',
      });
    } catch (e: any) {
      this.logger.warn(`Push parrainage échoué (${customerId}): ${e?.message}`);
    }
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

  /** Normalise une config cadeau : v2 { mode, items } OU legacy { type, payload }. */
  private normalizeGiftConfig(raw: any): ReferralGiftConfig | null {
    if (!raw) return null;
    if (raw.mode && Array.isArray(raw.items)) {
      const items = raw.items.filter((i: any) => i?.type && i?.payload);
      return items.length ? { mode: raw.mode === 'RANDOM' ? 'RANDOM' : 'FIXED', items } : null;
    }
    if (raw.type && raw.payload) {
      return { mode: 'FIXED', items: [raw] };
    }
    return null;
  }

  /**
   * Enrichit les items GIFT d'une config au moment de la SAUVEGARDE : snapshot
   * `{ item_type, dish_id|supplement_id, name, price, image? }` depuis le
   * catalogue — même forme que les campagnes « Envoyer un cadeau ». Un cadeau
   * peut être un PLAT/MENU **ou un SUPPLÉMENT** ; le grattage app affiche ainsi
   * image + nom, et la commande valide l'article (validateGiftLines).
   */
  private async enrichGiftItems(cfg: ReferralGiftConfig | null): Promise<ReferralGiftConfig | null> {
    if (!cfg) return null;
    const items: ReferralGiftItem[] = [];
    for (const item of cfg.items) {
      if (item.type !== RewardType.GIFT) {
        items.push(item);
        continue;
      }
      const p = item.payload ?? {};
      if (p.supplement_id) {
        const supp = await this.prisma.supplement.findUnique({ where: { id: p.supplement_id } });
        if (!supp || supp.available === false) {
          throw new BadRequestException('Cadeau : supplément introuvable ou indisponible.');
        }
        items.push({
          ...item,
          payload: {
            item_type: 'SUPPLEMENT',
            supplement_id: supp.id,
            name: supp.name,
            price: supp.price,
            ...(supp.image ? { image: supp.image } : {}),
          },
        });
      } else if (p.dish_id) {
        const dish = await this.prisma.dish.findUnique({ where: { id: p.dish_id } });
        if (!dish || dish.entity_status === EntityStatus.DELETED) {
          throw new BadRequestException('Cadeau : plat introuvable ou indisponible.');
        }
        items.push({
          ...item,
          payload: {
            item_type: 'DISH',
            dish_id: dish.id,
            name: dish.name,
            price: dish.price,
            ...(dish.image ? { image: dish.image } : {}),
          },
        });
      } else {
        throw new BadRequestException('Cadeau GIFT : sélectionnez un plat ou un supplément.');
      }
    }
    return { ...cfg, items };
  }

  /** Cadeau du PARRAIN (à l'utilisation du cadeau filleul). Défaut : bon 2000 F. */
  private async getParrainGiftConfig(): Promise<ReferralGiftConfig> {
    const raw = await this.settingsService.getJson<any>('reward.referral.parrain');
    return (
      this.normalizeGiftConfig(raw) ?? {
        mode: 'FIXED',
        items: [{ type: RewardType.VOUCHER, payload: { amount: 2000 } }],
      }
    );
  }

  /** Cadeau du FILLEUL (à l'inscription avec un code). Défaut : bon `welcome_amount`. */
  private async getFilleulGiftConfig(): Promise<ReferralGiftConfig> {
    const raw = await this.settingsService.getJson<any>('reward.referral.filleul');
    const normalized = this.normalizeGiftConfig(raw);
    if (normalized) return normalized;
    const amount = await this.getWelcomeAmount();
    return { mode: 'FIXED', items: [{ type: RewardType.VOUCHER, payload: { amount } }] };
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
}
