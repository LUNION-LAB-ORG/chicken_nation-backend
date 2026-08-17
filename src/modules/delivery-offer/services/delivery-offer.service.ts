import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
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
  /**
   * Distance restaurant → client, en KILOMÈTRES.
   *
   * Indispensable aux offres à prix imposé par palier. Absente, une offre à
   * paliers ne s'applique pas : mieux vaut facturer le tarif habituel que
   * deviner le palier.
   */
  distanceKm?: number | null;
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

/** Un palier de prix imposé, tel qu'enregistré dans `price_tiers`. */
interface PalierPrixImpose {
  max_km: number;
  price: number;
}

/**
 * Lit les paliers d'une offre à prix imposé.
 *
 * Tolérant par construction : la colonne est du Json libre, écrit par le
 * backoffice. Une entrée mal formée est ignorée plutôt que de faire échouer
 * tout le calcul du frais de livraison.
 */
export function lirePaliersPrix(brut: unknown): PalierPrixImpose[] {
  const source = typeof brut === 'string' ? safeParse(brut) : brut;
  if (!Array.isArray(source)) return [];

  const paliers: PalierPrixImpose[] = [];
  for (const entree of source) {
    if (!entree || typeof entree !== 'object') continue;
    const max = Number((entree as Record<string, unknown>).max_km);
    const prix = Number((entree as Record<string, unknown>).price);
    if (!Number.isFinite(max) || max <= 0) continue;
    if (!Number.isFinite(prix) || prix < 0) continue;
    paliers.push({ max_km: max, price: prix });
  }
  // Du plus proche au plus lointain : le premier palier qui couvre gagne.
  return paliers.sort((a, b) => a.max_km - b.max_km);
}

function safeParse(texte: string): unknown {
  try {
    return JSON.parse(texte);
  } catch {
    return null;
  }
}

/**
 * Prix imposé par une offre FIXED_PRICE pour une distance donnée.
 *
 * `null` signifie « cette offre ne dit rien pour cette distance » : on est
 * au-delà du dernier palier, et la livraison doit suivre le système habituel.
 */
export function prixImpose(
  paliers: PalierPrixImpose[],
  valeurParDefaut: number,
  distanceKm?: number | null,
): number | null {
  // Aucun palier : le prix vaut partout (« 1000 F partout »).
  //
  // Un prix à ZÉRO n'en est pas un : `value` vaut 0 par défaut en base, si bien
  // qu'une offre créée sans prix ni palier aurait rendu TOUTES les livraisons
  // gratuites en silence. La gratuité se demande avec FREE_DELIVERY.
  if (paliers.length === 0) {
    return Number.isFinite(valeurParDefaut) && valeurParDefaut > 0 ? valeurParDefaut : null;
  }
  if (typeof distanceKm !== 'number' || !Number.isFinite(distanceKm) || distanceKm < 0) {
    return null;
  }
  const palier = paliers.find((p) => distanceKm <= p.max_km);
  return palier ? palier.price : null;
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

  /**
   * Une offre à prix imposé doit dire un prix.
   *
   * `value` vaut 0 par défaut en base : sans ce contrôle, un POST qui omet le
   * prix et les paliers créait une offre ACTIVE rendant toutes les livraisons
   * gratuites. Et un PATCH ne portant que `type` héritait de l'ancien `value`,
   * une offre à 50 % devenant une livraison à 50 F.
   *
   * On valide donc l'état FUSIONNÉ, jamais le seul corps de la requête.
   */
  private validerPrixImpose(etat: {
    type?: DeliveryOfferType | null;
    value?: number | null;
    price_tiers?: unknown;
  }) {
    if (etat.type !== DeliveryOfferType.FIXED_PRICE) return;

    const paliers = lirePaliersPrix(etat.price_tiers);
    if (paliers.length > 0) {
      const distances = paliers.map((p) => p.max_km);
      if (new Set(distances).size !== distances.length) {
        throw new BadRequestException(
          'Deux paliers ne peuvent pas couvrir la même distance',
        );
      }
      // Trié par distance : un palier plus long ne peut pas coûter moins cher,
      // sinon le client le plus proche paie le plus cher.
      for (let i = 1; i < paliers.length; i++) {
        if (paliers[i].price < paliers[i - 1].price) {
          throw new BadRequestException(
            'Un palier plus lointain ne peut pas coûter moins cher qu\'un palier plus proche',
          );
        }
      }
      return;
    }

    if (!etat.value || etat.value <= 0) {
      throw new BadRequestException(
        'Indiquez un prix de livraison supérieur à 0, ou au moins un palier de distance. ' +
          'Pour offrir la livraison, choisissez le type « Livraison gratuite ».',
      );
    }
  }

  async create(req: Request, dto: CreateDeliveryOfferDto): Promise<DeliveryOffer> {
    const user = req.user as User | undefined;
    this.validerPrixImpose(dto);
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
    const existante = await this.findOne(id);
    // État FUSIONNÉ : un PATCH partiel ne dit pas tout, et ce qu'il tait vient
    // de la ligne existante.
    this.validerPrixImpose({
      type: dto.type ?? existante.type,
      value: dto.value ?? existante.value,
      price_tiers: dto.price_tiers ?? existante.price_tiers,
    });
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
    /**
     * Les paliers sont écrits tels quels, mais NETTOYÉS au passage : le
     * backoffice envoie parfois des lignes vides quand le gestionnaire ajoute
     * un palier puis change d'avis, et une ligne sans distance ni prix ferait
     * un palier fantôme que personne ne verrait à la relecture.
     */
    if (dto.price_tiers !== undefined) {
      out.price_tiers = (dto.price_tiers ?? [])
        .filter(
          (t) =>
            Number.isFinite(Number(t?.max_km)) &&
            Number(t.max_km) > 0 &&
            Number.isFinite(Number(t?.price)) &&
            Number(t.price) >= 0,
        )
        .map((t) => ({ max_km: Number(t.max_km), price: Number(t.price) }))
        .sort((a, b) => a.max_km - b.max_km);
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
          (lvl === LoyaltyLevel.VIP && offer.target_premium) ||
          (lvl === LoyaltyLevel.VVIP && offer.target_gold);
        if (!ok) continue;
      }
      // Jours de la semaine
      if (offer.days_of_week.length > 0 && !offer.days_of_week.includes(weekday)) {
        continue;
      }
      // Créneau horaire — gère aussi les fenêtres qui passent MINUIT (ex. 10:00 -> 02:00).
      // Fenêtre "normale" (start <= end) : heure DANS [start, end].
      // Fenêtre nocturne (start > end)  : heure >= start OU <= end.
      // (Avant : `>= start && <= end` -> une fenêtre nocturne = intersection VIDE = offre
      //  jamais appliquée. C'est ce qui bloquait "Livraison gratuite 2" 10:00->02:00.)
      if (offer.time_start && offer.time_end) {
        const inWindow =
          offer.time_start <= offer.time_end
            ? hhmm >= offer.time_start && hhmm <= offer.time_end
            : hhmm >= offer.time_start || hhmm <= offer.time_end;
        if (!inWindow) continue;
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
      /**
       * Les trois premiers types sont des REMISES : ils n'ont de sens que
       * s'ils baissent le prix. Le quatrième IMPOSE un prix, il s'applique donc
       * même quand il ne fait pas gagner d'argent au client.
       */
      let estPrixImpose = false;

      if (offer.type === DeliveryOfferType.FREE_DELIVERY) {
        newFee = 0;
      } else if (offer.type === DeliveryOfferType.PERCENTAGE) {
        newFee = Math.max(0, Math.round(ctx.baseFee * (1 - offer.value / 100)));
      } else if (offer.type === DeliveryOfferType.FIXED_AMOUNT) {
        newFee = Math.max(0, ctx.baseFee - offer.value);
      } else if (offer.type === DeliveryOfferType.FIXED_PRICE) {
        const impose = prixImpose(
          lirePaliersPrix(offer.price_tiers),
          offer.value,
          ctx.distanceKm,
        );
        // Au-delà du dernier palier : l'offre ne dit rien, on garde le tarif
        // habituel (grille Chicken ou zones Turbo selon le paramétrage).
        if (impose === null) continue;
        /**
         * Le prix imposé ne dépasse JAMAIS le tarif calculé.
         *
         * Une offre qui renchérit casse tout ce qui vit en aval : le montant
         * annoncé à Turbo comme coût réel de la course (`Math.max(base, facturé)`)
         * devenait le prix client et non le prix de revient, l'invariant
         * comptable « base = facturé + remise » tombait, et un client ciblé
         * payait plus cher que le frais affiché avant paiement, l'aperçu ne
         * portant aucune identité.
         *
         * Pour RENCHÉRIR une course courte, c'est la grille de livraison qu'il
         * faut modifier, dans les paramètres. Une offre ne fait que baisser.
         */
        newFee = Math.min(ctx.baseFee, Math.max(0, Math.round(impose)));
        estPrixImpose = true;
      }

      // La remise ne descend jamais sous zéro : un prix imposé PLUS CHER que la
      // grille reste une decision tarifaire, pas une remise negative.
      const discount = Math.max(0, ctx.baseFee - newFee);
      if (!estPrixImpose && discount <= 0) continue;
      if (estPrixImpose && newFee === ctx.baseFee) continue;

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
