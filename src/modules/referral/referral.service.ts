import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, ReferralStatus, RewardStatus, RewardType } from '@prisma/client';
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
   * du parrain (carte à gratter configurée). Appelé depuis le flux de paiement.
   * No-op si le filleul n'a pas de parrainage en attente.
   */
  async qualifyReferralForPaidOrder(refereeId: string, orderId: string): Promise<void> {
    const claim = await this.prisma.referral.updateMany({
      where: { referee_id: refereeId, status: ReferralStatus.PENDING },
      data: {
        status: ReferralStatus.REWARDED,
        qualifying_order_id: orderId,
        qualified_at: new Date(),
        updated_at: new Date(),
      },
    });
    if (claim.count === 0) return; // pas de parrainage en attente / déjà récompensé

    const referral = await this.prisma.referral.findUnique({ where: { referee_id: refereeId } });
    if (!referral) return;

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

  // ── Admin (back office) ───────────────────────────────────────────────────

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

  /** Configuration courante du parrainage (réglages + défauts effectifs). */
  async getConfig() {
    const welcome_amount = await this.getWelcomeAmount();
    const parrain = await this.getParrainRewardConfig();
    const created_by = (await this.settingsService.get('reward.referral.created_by')) ?? null;
    return { welcome_amount, parrain, created_by };
  }

  /** Met à jour la configuration du parrainage (réglages). */
  async setConfig(dto: {
    welcome_amount?: number;
    parrain?: { type: RewardType; payload: Record<string, any>; expires_in_days?: number };
    created_by?: string | null;
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
