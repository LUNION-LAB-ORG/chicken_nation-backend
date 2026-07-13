import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EntityStatus, Prisma, RewardStatus, RewardType } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { ExpoPushService } from 'src/expo-push/expo-push.service';
import { CreateRewardCampaignDto } from '../dto/create-reward-campaign.dto';

type CampaignRow = Prisma.RewardCampaignGetPayload<object>;

/**
 * Campagnes « Envoyer un cadeau » (Reward v2).
 *
 * Distribue des `Reward` (GIFT | VOUCHER | PROMO_CODE) à un client / une liste /
 * tous (filtre niveau fidélité optionnel), en immédiat ou programmé. La lecture
 * et le grattage restent gérés par `RewardService` (agnostiques au type). La
 * contrepartie « réelle » d'un VOUCHER est créée AU GRATTAGE (cf. RewardService).
 */
@Injectable()
export class RewardCampaignService {
  private readonly logger = new Logger(RewardCampaignService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly expoPushService: ExpoPushService,
  ) {}

  async createCampaign(dto: CreateRewardCampaignDto, adminId: string) {
    if (dto.type === RewardType.POINTS) {
      throw new BadRequestException('Le type POINTS est réservé aux commandes.');
    }
    if (dto.target_type === 'ids' && (!dto.ids || dto.ids.length === 0)) {
      throw new BadRequestException('Sélectionnez au moins un client destinataire.');
    }

    // Valide + enrichit le payload selon le type (snapshot PromoCode, etc.).
    const payload = await this.buildPayload(dto.type, dto.payload ?? {});

    const targetConfig: Record<string, unknown> = {
      ...(dto.target_type === 'ids' ? { ids: dto.ids } : {}),
      ...(dto.loyalty_level ? { loyalty_level: dto.loyalty_level } : {}),
    };

    const scheduledAt = dto.scheduled_at ? new Date(dto.scheduled_at) : null;
    const isScheduled = !!scheduledAt && scheduledAt.getTime() > Date.now();
    const expiresAt = dto.expires_at ? new Date(dto.expires_at) : null;
    if (expiresAt && expiresAt.getTime() < Date.now()) {
      throw new BadRequestException("La date d'expiration ne peut pas être dans le passé.");
    }

    const campaign = await this.prisma.rewardCampaign.create({
      data: {
        name: dto.name,
        type: dto.type,
        payload: payload as Prisma.InputJsonValue,
        target_type: dto.target_type,
        target_config: targetConfig as Prisma.InputJsonValue,
        expires_at: expiresAt,
        status: isScheduled ? 'scheduled' : 'sending',
        scheduled_at: scheduledAt,
        created_by: adminId,
      },
    });

    if (!isScheduled) {
      await this.dispatch(campaign);
    }
    return this.getCampaign(campaign.id);
  }

  /**
   * Distribue effectivement la campagne : crée 1 Reward PENDING par destinataire,
   * met à jour les stats et pousse « un cadeau vous attend » aux clients opt-in.
   * Appelé en immédiat (createCampaign) OU par le cron (campagne programmée).
   */
  async dispatch(campaign: CampaignRow) {
    const config = (campaign.target_config ?? {}) as { ids?: string[]; loyalty_level?: string };
    const customerIds = await this.resolveCustomerIds(campaign.target_type, config);

    if (customerIds.length > 0) {
      await this.prisma.reward.createMany({
        data: customerIds.map((customer_id) => ({
          customer_id,
          type: campaign.type,
          payload: campaign.payload as Prisma.InputJsonValue,
          reason: campaign.name,
          campaign_id: campaign.id,
          expires_at: campaign.expires_at,
          status: RewardStatus.PENDING,
        })),
      });
      this.sendGiftPush(customerIds).catch((e) =>
        this.logger.warn(`Push « cadeau » échoué (campagne ${campaign.id}): ${e?.message}`),
      );
    }

    await this.prisma.rewardCampaign.update({
      where: { id: campaign.id },
      data: { status: 'sent', sent_at: new Date(), total_targeted: customerIds.length },
    });
    this.logger.log(`Campagne ${campaign.id} envoyée à ${customerIds.length} client(s).`);
  }

  private async resolveCustomerIds(
    targetType: string,
    config: { ids?: string[]; loyalty_level?: string },
  ): Promise<string[]> {
    if (targetType === 'ids') {
      return config.ids ?? [];
    }
    // all (+ filtre niveau fidélité optionnel)
    const where: Prisma.CustomerWhereInput = {
      entity_status: { not: EntityStatus.DELETED },
      ...(config.loyalty_level ? { loyalty_level: config.loyalty_level as any } : {}),
    };
    const customers = await this.prisma.customer.findMany({ where, select: { id: true } });
    return customers.map((c) => c.id);
  }

  private async sendGiftPush(customerIds: string[]) {
    const settings = await this.prisma.notificationSetting.findMany({
      where: {
        customer_id: { in: customerIds },
        push: true,
        active: true,
        expo_push_token: { not: null },
      },
      select: { expo_push_token: true },
    });
    const tokens = settings.map((s) => s.expo_push_token).filter((t): t is string => !!t);
    if (tokens.length === 0) return;

    await this.expoPushService.sendPushNotifications({
      tokens,
      title: '🎁 Un cadeau vous attend !',
      body: 'Ouvrez Chicken Nation pour gratter et découvrir votre surprise.',
      sound: 'default',
      priority: 'high',
      data: { type: 'reward_gift' },
    });
  }

  /**
   * Valide et enrichit le payload selon le type. Pour PROMO_CODE, vérifie que le
   * code existe et est actif, et snapshotte la remise (le front app la rendra).
   */
  private async buildPayload(
    type: RewardType,
    payload: Record<string, any>,
  ): Promise<Record<string, any>> {
    if (type === RewardType.GIFT) {
      if (!payload.label || typeof payload.label !== 'string') {
        throw new BadRequestException('Un libellé (label) est requis pour un cadeau.');
      }
      return { label: payload.label, ...(payload.image ? { image: payload.image } : {}) };
    }

    if (type === RewardType.VOUCHER) {
      const amount = Number(payload.amount);
      if (!(amount > 0)) {
        throw new BadRequestException('Un montant strictement positif est requis pour un bon.');
      }
      return { amount };
    }

    if (type === RewardType.PROMO_CODE) {
      if (!payload.code || typeof payload.code !== 'string') {
        throw new BadRequestException('Un code promo est requis.');
      }
      const promo = await this.prisma.promoCode.findUnique({ where: { code: payload.code } });
      if (!promo || !promo.is_active || promo.entity_status === EntityStatus.DELETED) {
        throw new BadRequestException('Code promo introuvable ou inactif.');
      }
      return {
        code: promo.code,
        discount_type: promo.discount_type,
        discount_value: promo.discount_value,
        ...(promo.description ? { description: promo.description } : {}),
      };
    }

    throw new BadRequestException('Type de campagne non supporté.');
  }

  /** Compteur de récompenses grattées par campagne (suivi). */
  private async scratchedCounts(campaignIds: string[]): Promise<Map<string, number>> {
    if (campaignIds.length === 0) return new Map();
    const grouped = await this.prisma.reward.groupBy({
      by: ['campaign_id'],
      where: { campaign_id: { in: campaignIds }, status: RewardStatus.SCRATCHED },
      _count: { _all: true },
    });
    return new Map(grouped.map((g) => [g.campaign_id as string, g._count._all]));
  }

  async listCampaigns() {
    const campaigns = await this.prisma.rewardCampaign.findMany({
      orderBy: { created_at: 'desc' },
    });
    const scratched = await this.scratchedCounts(campaigns.map((c) => c.id));
    return campaigns.map((c) => ({ ...c, scratched_count: scratched.get(c.id) ?? 0 }));
  }

  async getCampaign(id: string) {
    const campaign = await this.prisma.rewardCampaign.findUnique({ where: { id } });
    if (!campaign) throw new NotFoundException('Campagne introuvable');
    const scratched = await this.scratchedCounts([id]);
    return { ...campaign, scratched_count: scratched.get(id) ?? 0 };
  }

  /** Annule une campagne encore PROGRAMMÉE (non distribuée). */
  async cancelCampaign(id: string) {
    const res = await this.prisma.rewardCampaign.updateMany({
      where: { id, status: 'scheduled' },
      data: { status: 'cancelled', updated_at: new Date() },
    });
    if (res.count === 0) {
      throw new BadRequestException('Campagne non annulable (déjà envoyée, en cours, ou inexistante).');
    }
    return { cancelled: true };
  }
}
