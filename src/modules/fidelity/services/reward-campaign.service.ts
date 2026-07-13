import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EntityStatus, Prisma, RewardStatus, RewardType } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { ExpoPushService } from 'src/expo-push/expo-push.service';
import { SettingsService } from 'src/modules/settings/settings.service';
import { CreateRewardCampaignDto } from '../dto/create-reward-campaign.dto';

type CampaignRow = Prisma.RewardCampaignGetPayload<object>;

/** Funnel d'impact d'une campagne. `null` = non suivi (GIFT). */
type CampaignMetrics = {
  scratched: number;
  redeemed: number | null;
  revenue: number | null;
  discount_cost: number | null;
};

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
    private readonly settingsService: SettingsService,
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
      ...(dto.ignore_capping ? { ignore_capping: true } : {}),
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
    const config = (campaign.target_config ?? {}) as {
      ids?: string[];
      loyalty_level?: string;
      ignore_capping?: boolean;
    };
    let customerIds = await this.resolveCustomerIds(campaign.target_type, config);

    // Capping anti-fatigue : on n'envoie PAS un nouveau cadeau à un client qui en a
    // déjà reçu un récemment (cooldown configurable). Contournable par campagne
    // (ignore_capping) pour les opérations exceptionnelles.
    let skippedCapping = 0;
    if (!config.ignore_capping && customerIds.length > 0) {
      const kept = await this.applyCapping(customerIds);
      skippedCapping = customerIds.length - kept.length;
      customerIds = kept;
    }

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
      data: {
        status: 'sent',
        sent_at: new Date(),
        total_targeted: customerIds.length,
        // Trace le capping pour le suivi (pas de colonne dédiée → target_config).
        ...(skippedCapping > 0
          ? { target_config: { ...config, skipped_capping: skippedCapping } as Prisma.InputJsonValue }
          : {}),
      },
    });
    this.logger.log(
      `Campagne ${campaign.id} envoyée à ${customerIds.length} client(s)` +
        (skippedCapping > 0 ? `, ${skippedCapping} ignoré(s) (capping anti-fatigue).` : '.'),
    );
  }

  /**
   * Fenêtre de cooldown (jours) entre deux cadeaux pour un même client. Réglage
   * backoffice `reward.capping.cooldown_days` (défaut 7). `0` = capping désactivé.
   */
  private async getCappingCooldownDays(): Promise<number> {
    const raw = await this.settingsService.get('reward.capping.cooldown_days');
    // Absent/vide → défaut 7 j (⚠️ Number(null)===0 : ne PAS laisser un réglage
    // manquant désactiver silencieusement le capping). `0` explicite = désactivé.
    if (raw === null || raw.trim() === '') return 7;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 7;
  }

  /**
   * Retire les clients ayant reçu une récompense DE CAMPAGNE (campaign_id non nul)
   * dans la fenêtre de cooldown → anti-sur-sollicitation. Les points gagnés sur
   * commande (campaign_id nul) ne comptent PAS.
   */
  private async applyCapping(customerIds: string[]): Promise<string[]> {
    const cooldownDays = await this.getCappingCooldownDays();
    if (cooldownDays <= 0) return customerIds;
    const since = new Date(Date.now() - cooldownDays * 24 * 60 * 60 * 1000);
    const recent = await this.prisma.reward.findMany({
      where: {
        customer_id: { in: customerIds },
        campaign_id: { not: null },
        created_at: { gte: since },
      },
      select: { customer_id: true },
      distinct: ['customer_id'],
    });
    const capped = new Set(recent.map((r) => r.customer_id));
    return customerIds.filter((id) => !capped.has(id));
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
      // Un cadeau référence un PLAT précis du menu (le client l'ajoutera au panier
      // à 0 fr). On snapshotte nom/prix/image : le prix = coût du cadeau (funnel #1),
      // le nom/image survivent à une évolution ultérieure du plat.
      const dishId = payload.dish_id;
      if (!dishId || typeof dishId !== 'string') {
        throw new BadRequestException('Sélectionnez le plat offert (dish_id).');
      }
      const dish = await this.prisma.dish.findUnique({ where: { id: dishId } });
      if (!dish || dish.entity_status === EntityStatus.DELETED) {
        throw new BadRequestException('Plat introuvable ou indisponible.');
      }
      return {
        item_type: 'DISH',
        dish_id: dish.id,
        label: typeof payload.label === 'string' && payload.label.trim() ? payload.label.trim() : dish.name,
        name: dish.name,
        price: dish.price,
        ...(dish.image ? { image: dish.image } : {}),
      };
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

  /**
   * Funnel d'impact par campagne : distribué → GRATTÉ → UTILISÉ → CA généré.
   *
   * « Utilisé » et « CA » traversent la comptabilité réelle (pas juste le grattage) :
   *  - VOUCHER : reward grattée → `voucher_id` (payload) → Redemption(s) → commande.
   *  - PROMO_CODE : usages du code (PromoCodeUsage) par les destinataires depuis
   *    `sent_at` → commande. Destinataires = `target_config.ids` (ciblage liste) ;
   *    pour « tous », on n'impose pas de filtre client (le code est partagé, donc
   *    l'attribution retenue = usages du code après l'envoi — heuristique standard).
   *  - GIFT : aucun instrument numérique → `null` (utilisation non suivie côté système).
   *
   * Batch BORNÉ (≈ requêtes constantes quel que soit le nombre de campagnes) :
   * 1 groupBy grattés + 1 findMany rewards-voucher + 1 redemptions + 1 usages +
   * 1 findMany codes + 1 findMany commandes. Aucun N+1.
   */
  private async computeCampaignMetrics(
    campaigns: CampaignRow[],
  ): Promise<Map<string, CampaignMetrics>> {
    const result = new Map<string, CampaignMetrics>();
    if (campaigns.length === 0) return result;

    const ids = campaigns.map((c) => c.id);
    const byType = (t: RewardType) => campaigns.filter((c) => c.type === t);

    // 1) Grattés (tous types) — 1 groupBy.
    const scratchedGrouped = await this.prisma.reward.groupBy({
      by: ['campaign_id'],
      where: { campaign_id: { in: ids }, status: RewardStatus.SCRATCHED },
      _count: { _all: true },
    });
    const scratchedMap = new Map<string, number>(
      scratchedGrouped.map((g) => [g.campaign_id as string, g._count._all]),
    );
    // Tous les types sont désormais suivis (GIFT via CONSUMED, cf. rédemption panier).
    for (const c of campaigns) {
      result.set(c.id, {
        scratched: scratchedMap.get(c.id) ?? 0,
        redeemed: 0,
        revenue: 0,
        discount_cost: 0,
      });
    }

    // Collecte des commandes touchées → 1 seule résolution du CA à la fin.
    const orderIds = new Set<string>();
    const campaignOrders = new Map<string, Set<string>>();
    const linkOrder = (cid: string, oid?: string | null) => {
      if (!oid) return;
      orderIds.add(oid);
      if (!campaignOrders.has(cid)) campaignOrders.set(cid, new Set());
      campaignOrders.get(cid)!.add(oid);
    };

    // 2) VOUCHER : rewards grattées → voucher_id → redemptions.
    const voucherCampaigns = byType(RewardType.VOUCHER);
    if (voucherCampaigns.length > 0) {
      const scratchedRewards = await this.prisma.reward.findMany({
        where: {
          campaign_id: { in: voucherCampaigns.map((c) => c.id) },
          type: RewardType.VOUCHER,
          status: RewardStatus.SCRATCHED,
        },
        select: { campaign_id: true, payload: true },
      });
      const voucherToCampaign = new Map<string, string>();
      for (const r of scratchedRewards) {
        const vid = (r.payload as Record<string, any> | null)?.voucher_id;
        if (vid && r.campaign_id) voucherToCampaign.set(vid, r.campaign_id);
      }
      const voucherIds = [...voucherToCampaign.keys()];
      if (voucherIds.length > 0) {
        const redemptions = await this.prisma.redemption.findMany({
          where: { voucher_id: { in: voucherIds }, entity_status: EntityStatus.ACTIVE },
          select: { voucher_id: true, order_id: true, amount: true },
        });
        const redeemedVouchers = new Map<string, Set<string>>();
        for (const red of redemptions) {
          const cid = voucherToCampaign.get(red.voucher_id);
          if (!cid) continue;
          const m = result.get(cid)!;
          m.discount_cost = (m.discount_cost ?? 0) + (red.amount ?? 0);
          if (!redeemedVouchers.has(cid)) redeemedVouchers.set(cid, new Set());
          redeemedVouchers.get(cid)!.add(red.voucher_id);
          linkOrder(cid, red.order_id);
        }
        for (const [cid, set] of redeemedVouchers) result.get(cid)!.redeemed = set.size;
      }
    }

    // 3) PROMO_CODE : usages du code par les destinataires depuis l'envoi.
    const promoCampaigns = byType(RewardType.PROMO_CODE);
    if (promoCampaigns.length > 0) {
      const codes = [
        ...new Set(
          promoCampaigns
            .map((c) => (c.payload as Record<string, any> | null)?.code)
            .filter((c): c is string => !!c),
        ),
      ];
      const promos = codes.length
        ? await this.prisma.promoCode.findMany({
            where: { code: { in: codes } },
            select: { id: true, code: true },
          })
        : [];
      const codeToPromoId = new Map(promos.map((p) => [p.code, p.id]));
      const promoIds = promos.map((p) => p.id);
      if (promoIds.length > 0) {
        const usages = await this.prisma.promoCodeUsage.findMany({
          where: { promo_code_id: { in: promoIds }, order_id: { not: null } },
          select: {
            promo_code_id: true,
            customer_id: true,
            order_id: true,
            discount_amount: true,
            created_at: true,
          },
        });
        for (const c of promoCampaigns) {
          const promoId = codeToPromoId.get((c.payload as Record<string, any> | null)?.code);
          if (!promoId) continue;
          const since = c.sent_at ? new Date(c.sent_at).getTime() : 0;
          // Ciblage liste → filtre sur les destinataires ; « tous » → pas de filtre client.
          const recipients =
            c.target_type === 'ids'
              ? new Set<string>(((c.target_config as Record<string, any> | null)?.ids as string[]) ?? [])
              : null;
          const m = result.get(c.id)!;
          const redeemedCustomers = new Set<string>();
          for (const u of usages) {
            if (u.promo_code_id !== promoId) continue;
            if (recipients && !recipients.has(u.customer_id)) continue;
            if (since && u.created_at.getTime() < since) continue;
            redeemedCustomers.add(u.customer_id);
            m.discount_cost = (m.discount_cost ?? 0) + (u.discount_amount ?? 0);
            linkOrder(c.id, u.order_id);
          }
          m.redeemed = redeemedCustomers.size;
        }
      }
    }

    // 3bis) GIFT : cadeaux CONSUMED (ajoutés à une commande à 0 fr). redeemed =
    // nombre consommé ; coût = Σ prix snapshot du plat offert ; CA = net_amount de
    // la commande sur laquelle le cadeau a été utilisé (part payante attribuée).
    const giftCampaigns = byType(RewardType.GIFT);
    if (giftCampaigns.length > 0) {
      const consumed = await this.prisma.reward.findMany({
        where: {
          campaign_id: { in: giftCampaigns.map((c) => c.id) },
          type: RewardType.GIFT,
          status: RewardStatus.CONSUMED,
        },
        select: { campaign_id: true, order_id: true, payload: true },
      });
      for (const r of consumed) {
        if (!r.campaign_id) continue;
        const m = result.get(r.campaign_id)!;
        m.redeemed = (m.redeemed ?? 0) + 1;
        m.discount_cost =
          (m.discount_cost ?? 0) + Number((r.payload as Record<string, any> | null)?.price ?? 0);
        linkOrder(r.campaign_id, r.order_id);
      }
    }

    // 4) CA net des commandes touchées (VOUCHER + PROMO + GIFT) — 1 requête.
    if (orderIds.size > 0) {
      const orders = await this.prisma.order.findMany({
        where: { id: { in: [...orderIds] } },
        select: { id: true, net_amount: true },
      });
      const orderNet = new Map(orders.map((o) => [o.id, o.net_amount ?? 0]));
      for (const [cid, set] of campaignOrders) {
        let sum = 0;
        for (const oid of set) sum += orderNet.get(oid) ?? 0;
        result.get(cid)!.revenue = sum;
      }
    }

    return result;
  }

  private withMetrics(campaign: CampaignRow, metrics?: CampaignMetrics) {
    const m = metrics ?? { scratched: 0, redeemed: null, revenue: null, discount_cost: null };
    return {
      ...campaign,
      scratched_count: m.scratched,
      redeemed_count: m.redeemed,
      revenue: m.revenue,
      discount_cost: m.discount_cost,
    };
  }

  async listCampaigns() {
    const campaigns = await this.prisma.rewardCampaign.findMany({
      orderBy: { created_at: 'desc' },
    });
    const metrics = await this.computeCampaignMetrics(campaigns);
    return campaigns.map((c) => this.withMetrics(c, metrics.get(c.id)));
  }

  async getCampaign(id: string) {
    const campaign = await this.prisma.rewardCampaign.findUnique({ where: { id } });
    if (!campaign) throw new NotFoundException('Campagne introuvable');
    const metrics = await this.computeCampaignMetrics([campaign]);
    return this.withMetrics(campaign, metrics.get(id));
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
