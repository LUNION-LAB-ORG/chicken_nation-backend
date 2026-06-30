import { Injectable, NotFoundException } from '@nestjs/common';
import {
  DeliveryOffer,
  DeliveryOfferType,
  EntityStatus,
  LoyaltyLevel,
  Prisma,
  PromoCodeUsageStatus,
  User,
} from '@prisma/client';
import type { Request } from 'express';
import { PrismaService } from 'src/database/services/prisma.service';
import { CreateDeliveryOfferDto } from '../dto/create-delivery-offer.dto';
import { UpdateDeliveryOfferDto } from '../dto/update-delivery-offer.dto';
import { QueryDeliveryOfferDto } from '../dto/query-delivery-offer.dto';

/** Contexte d'évaluation d'une offre au moment du calcul du frais. */
export interface DeliveryOfferContext {
  baseFee: number;
  restaurantId?: string | null;
  channel: 'APP' | 'CALL_CENTER';
  orderAmount: number;
  loyaltyLevel?: LoyaltyLevel | null;
  customerId?: string | null;
  now?: Date;
}

export interface ApplicableDeliveryOffer {
  offer: DeliveryOffer;
  newFee: number;
  discount: number;
}

const WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

@Injectable()
export class DeliveryOfferService {
  constructor(private readonly prisma: PrismaService) {}

  // ───────────────────────────── CRUD ─────────────────────────────

  async create(req: Request, dto: CreateDeliveryOfferDto): Promise<DeliveryOffer> {
    const user = req.user as User | undefined;
    return this.prisma.deliveryOffer.create({
      data: { ...this.toData(dto), created_by: user?.id ?? null },
    });
  }

  async findAll(query: QueryDeliveryOfferDto = {}) {
    const { page = 1, limit = 10, type, is_active, search } = query;
    const where: Prisma.DeliveryOfferWhereInput = {
      entity_status: { not: EntityStatus.DELETED },
    };
    if (type) where.type = type;
    if (is_active !== undefined) where.is_active = is_active;
    if (search) where.name = { contains: search, mode: 'insensitive' };

    const [data, total] = await Promise.all([
      this.prisma.deliveryOffer.findMany({
        where,
        orderBy: [{ priority: 'desc' }, { created_at: 'desc' }],
        take: limit,
        skip: (page - 1) * limit,
      }),
      this.prisma.deliveryOffer.count({ where }),
    ]);

    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOne(id: string): Promise<DeliveryOffer> {
    const offer = await this.prisma.deliveryOffer.findUnique({ where: { id } });
    if (!offer || offer.entity_status === EntityStatus.DELETED) {
      throw new NotFoundException('Offre de livraison introuvable');
    }
    return offer;
  }

  async update(id: string, dto: UpdateDeliveryOfferDto): Promise<DeliveryOffer> {
    await this.findOne(id);
    return this.prisma.deliveryOffer.update({
      where: { id },
      data: this.toData(dto),
    });
  }

  async remove(id: string): Promise<DeliveryOffer> {
    await this.findOne(id);
    return this.prisma.deliveryOffer.update({
      where: { id },
      data: { entity_status: EntityStatus.DELETED, is_active: false },
    });
  }

  async toggleActive(id: string): Promise<DeliveryOffer> {
    const offer = await this.findOne(id);
    return this.prisma.deliveryOffer.update({
      where: { id },
      data: { is_active: !offer.is_active },
    });
  }

  async getStats() {
    const [total, active] = await Promise.all([
      this.prisma.deliveryOffer.count({
        where: { entity_status: { not: EntityStatus.DELETED } },
      }),
      this.prisma.deliveryOffer.count({
        where: { entity_status: { not: EntityStatus.DELETED }, is_active: true },
      }),
    ]);
    return { total, active };
  }

  /** Normalise un DTO en payload Prisma (dates + champs définis seulement). */
  private toData(
    dto: CreateDeliveryOfferDto | UpdateDeliveryOfferDto,
  ): Prisma.DeliveryOfferUncheckedCreateInput {
    const out: Record<string, unknown> = {};
    const passthrough: (keyof CreateDeliveryOfferDto)[] = [
      'name',
      'description',
      'type',
      'value',
      'min_order_amount',
      'channel',
      'restaurant_ids',
      'target_standard',
      'target_premium',
      'target_gold',
      'days_of_week',
      'time_start',
      'time_end',
      'max_usage',
      'max_usage_per_user',
      'is_active',
      'priority',
    ];
    for (const key of passthrough) {
      if (dto[key] !== undefined) out[key] = dto[key];
    }
    if (dto.start_date !== undefined) out.start_date = new Date(dto.start_date);
    if (dto.expiration_date !== undefined) {
      out.expiration_date = new Date(dto.expiration_date);
    }
    return out as Prisma.DeliveryOfferUncheckedCreateInput;
  }

  // ─────────────────────── Application au frais ───────────────────────

  /**
   * Trouve la meilleure offre applicable à un frais de livraison donné et
   * renvoie le nouveau frais. `null` si aucune offre ne s'applique.
   * Critère : frais résultant le plus bas ; à égalité, priorité la plus haute.
   */
  async findApplicableOffer(
    ctx: DeliveryOfferContext,
  ): Promise<ApplicableDeliveryOffer | null> {
    const now = ctx.now ?? new Date();

    const offers = await this.prisma.deliveryOffer.findMany({
      where: {
        is_active: true,
        entity_status: EntityStatus.ACTIVE,
        start_date: { lte: now },
        expiration_date: { gte: now },
        OR: [{ channel: 'BOTH' }, { channel: ctx.channel }],
      },
      orderBy: [{ priority: 'desc' }, { created_at: 'desc' }],
    });

    // Niveau de fidélité résolu paresseusement (seulement si une offre le cible).
    let loyaltyResolved: LoyaltyLevel | null | undefined = ctx.loyaltyLevel;
    const resolveLoyalty = async (): Promise<LoyaltyLevel | null> => {
      if (loyaltyResolved !== undefined) return loyaltyResolved;
      if (ctx.customerId) {
        const c = await this.prisma.customer.findUnique({
          where: { id: ctx.customerId },
          select: { loyalty_level: true },
        });
        loyaltyResolved = c?.loyalty_level ?? null;
      } else {
        loyaltyResolved = null;
      }
      return loyaltyResolved;
    };

    const weekday = WEEKDAYS[now.getDay()];
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(
      now.getMinutes(),
    ).padStart(2, '0')}`;

    let best: ApplicableDeliveryOffer | null = null;

    for (const offer of offers) {
      // Restaurant ciblé
      if (
        offer.restaurant_ids.length > 0 &&
        (!ctx.restaurantId || !offer.restaurant_ids.includes(ctx.restaurantId))
      ) {
        continue;
      }
      // Montant minimum
      if (offer.min_order_amount && ctx.orderAmount < offer.min_order_amount) {
        continue;
      }
      // Ciblage fidélité (si au moins un niveau coché)
      const anyLevel =
        offer.target_standard || offer.target_premium || offer.target_gold;
      if (anyLevel) {
        const lvl = await resolveLoyalty();
        const ok =
          (lvl === LoyaltyLevel.STANDARD && offer.target_standard) ||
          (lvl === LoyaltyLevel.PREMIUM && offer.target_premium) ||
          (lvl === LoyaltyLevel.GOLD && offer.target_gold);
        if (!ok) continue;
      }
      // Jours de la semaine
      if (offer.days_of_week.length > 0 && !offer.days_of_week.includes(weekday)) {
        continue;
      }
      // Créneau horaire
      if (offer.time_start && offer.time_end) {
        if (!(hhmm >= offer.time_start && hhmm <= offer.time_end)) continue;
      }
      // Limite globale
      if (offer.max_usage != null && offer.usage_count >= offer.max_usage) {
        continue;
      }
      // Limite par client (usages ACTIFS)
      if (offer.max_usage_per_user && offer.max_usage_per_user > 0 && ctx.customerId) {
        const used = await this.prisma.deliveryOfferUsage.count({
          where: {
            delivery_offer_id: offer.id,
            customer_id: ctx.customerId,
            status: PromoCodeUsageStatus.ACTIVE,
          },
        });
        if (used >= offer.max_usage_per_user) continue;
      }

      // Nouveau frais selon le type
      let newFee = ctx.baseFee;
      if (offer.type === DeliveryOfferType.FREE_DELIVERY) {
        newFee = 0;
      } else if (offer.type === DeliveryOfferType.PERCENTAGE) {
        newFee = Math.max(0, Math.round(ctx.baseFee * (1 - offer.value / 100)));
      } else if (offer.type === DeliveryOfferType.FIXED_AMOUNT) {
        newFee = Math.max(0, ctx.baseFee - offer.value);
      }

      const discount = ctx.baseFee - newFee;
      if (discount <= 0) continue;

      // Meilleur = frais le plus bas ; à égalité on garde le 1er (priorité desc).
      if (!best || newFee < best.newFee) {
        best = { offer, newFee, discount };
      }
    }

    return best;
  }

  /** Enregistre l'utilisation d'une offre (INACTIVE à la création, ACTIVE au paiement). */
  async recordUsage(
    offerId: string,
    customerId: string,
    orderId: string | null,
    discountAmount: number,
    status: PromoCodeUsageStatus = PromoCodeUsageStatus.INACTIVE,
  ) {
    return this.prisma.deliveryOfferUsage.create({
      data: {
        delivery_offer_id: offerId,
        customer_id: customerId,
        order_id: orderId,
        discount_amount: discountAmount,
        status,
      },
    });
  }
}
