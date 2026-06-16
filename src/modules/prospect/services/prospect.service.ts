import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  DiscountType,
  EntityStatus,
  Prisma,
  ProspectCallResult,
  ProspectMessageKind,
  ProspectPlatform,
  ProspectStatus,
  TargetType,
  User,
  UserType,
} from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { SettingsService } from 'src/modules/settings/settings.service';
import { TwilioService } from 'src/twilio/services/twilio.service';
import { CreateProspectDto } from '../dto/create-prospect.dto';
import { MarkCallDto } from '../dto/mark-call.dto';
import { QueryProspectDto } from '../dto/query-prospect.dto';
import { UpdateProspectSettingsDto } from '../dto/update-prospect-settings.dto';

const DEFAULT_APP_LINK = 'https://chicken.turbodeliveryapp.com';

const DEFAULT_MESSAGES: Record<ProspectMessageKind, string> = {
  DECOUVERTE:
    'Bonjour {nom} ! Merci de commander chez Chicken Nation 🍗 Commandez désormais en direct sur notre app et payez moins cher. Votre code promo {code_coupon} (valable {validite} jours). Lien : {lien_app}',
  RELANCE_1:
    "Re-bonjour {nom} ! Profitez encore de tarifs réduits sur l'app Chicken Nation : {lien_app}. Code {code_coupon} (valable {validite} jours).",
  RELANCE_2_FIDELITE:
    "{nom}, merci pour votre fidélité ! 🎁 Offre exclusive sur l'app : {lien_app}. Votre code {code_coupon} (valable {validite} jours).",
};

@Injectable()
export class ProspectService {
  private readonly logger = new Logger(ProspectService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly twilio: TwilioService,
  ) {}

  /**
   * Un agent "store" (caissier/manager rattaché à un restaurant) est cloisonné :
   * il ne saisit/consulte que les contacts de SON restaurant. L'admin/central
   * (restaurant_id null) voit tout.
   */
  private isStoreUser(user: User): boolean {
    return user.type === UserType.RESTAURANT && !!user.restaurant_id;
  }

  /** Saisie d'un contact. Le store est forcé au restaurant de l'agent store. */
  async create(user: User, dto: CreateProspectDto) {
    const restaurantId = this.isStoreUser(user)
      ? user.restaurant_id!
      : dto.restaurant_id;

    if (!restaurantId) {
      throw new BadRequestException(
        'Le store (restaurant) est obligatoire pour enregistrer un contact.',
      );
    }

    // Garde-fou : le MÊME client peut être saisi plusieurs fois (phone non
    // unique), mais on empêche d'enregistrer DEUX FOIS exactement la même
    // commande (même plateforme + même n° de commande dans ce restaurant).
    const orderNumber = dto.order_number?.trim();
    if (orderNumber) {
      const dejaSaisie = await this.prisma.prospect.findFirst({
        where: {
          restaurant_id: restaurantId,
          platform: dto.platform,
          order_number: orderNumber,
          entity_status: { not: EntityStatus.DELETED },
        },
        select: { id: true },
      });
      if (dejaSaisie) {
        throw new BadRequestException(
          `La commande ${dto.platform} n° ${orderNumber} a déjà été enregistrée.`,
        );
      }
    }

    return this.prisma.prospect.create({
      data: {
        platform: dto.platform,
        name: dto.name?.trim() || 'Client', // Yango ne fournit pas de nom
        order_number: dto.order_number,
        phone: dto.phone,
        status: ProspectStatus.NOUVEAU,
        restaurant: { connect: { id: restaurantId } },
        ...(user.id && { creator: { connect: { id: user.id } } }),
      },
      include: { restaurant: { select: { id: true, name: true } } },
    });
  }

  /**
   * Détection de doublon par téléphone AVANT saisie (cf. cahier §4.3 :
   * « alerte doublon possible »). Cloisonné au store pour un agent store.
   */
  async checkPhone(user: User, phone: string) {
    const cleaned = (phone || '').replace(/\D/g, '');
    // Plage E.164 (6–15 chiffres) — aligné sur la validation de saisie.
    if (cleaned.length < 6 || cleaned.length > 15) {
      return { exists: false, prospect: null };
    }

    const where: Prisma.ProspectWhereInput = {
      phone: cleaned,
      entity_status: { not: EntityStatus.DELETED },
    };
    if (this.isStoreUser(user)) {
      where.restaurant_id = user.restaurant_id!;
    }

    const existing = await this.prisma.prospect.findFirst({
      where,
      orderBy: { created_at: 'desc' },
      include: { restaurant: { select: { id: true, name: true } } },
    });

    return {
      exists: !!existing,
      prospect: existing
        ? {
            id: existing.id,
            name: existing.name,
            status: existing.status,
            restaurant: existing.restaurant,
            created_at: existing.created_at,
          }
        : null,
    };
  }

  /**
   * Liste des contacts (admin), triée du plus ancien au plus récent (cahier §4.2).
   * Filtrage store/plateforme/statut/période + recherche.
   */
  async findAll(user: User, query: QueryProspectDto) {
    const {
      restaurantId,
      platform,
      status,
      search,
      startDate,
      endDate,
      page = 1,
      limit = 20,
    } = query;

    const where: Prisma.ProspectWhereInput = {
      entity_status: { not: EntityStatus.DELETED },
      ...(platform && { platform }),
      ...(status && { status }),
    };

    // Cloisonnement : agent store -> son restaurant ; admin -> filtre optionnel
    if (this.isStoreUser(user)) {
      where.restaurant_id = user.restaurant_id!;
    } else if (restaurantId) {
      where.restaurant_id = restaurantId;
    }

    if (search) {
      const s = search.trim();
      where.OR = [
        { name: { contains: s, mode: 'insensitive' } },
        { phone: { contains: s.replace(/\D/g, '') } },
        { order_number: { contains: s } },
      ];
    }

    if (startDate || endDate) {
      where.created_at = {
        ...(startDate && { gte: new Date(startDate) }),
        ...(endDate && {
          lte: new Date(new Date(endDate).setHours(23, 59, 59, 999)),
        }),
      };
    }

    const [data, total] = await Promise.all([
      this.prisma.prospect.findMany({
        where,
        include: {
          restaurant: { select: { id: true, name: true } },
          creator: { select: { id: true, fullname: true } },
        },
        // Plus récents en premier (le backoffice attend la commande la plus
        // fraîche en haut de table). L'ordre croissant existait pour le
        // workflow Call Center (qui appelle le plus ancien d'abord) ; ce
        // workflow utilise désormais le bucket `findCallQueue()` qui garde
        // son propre tri ascendant — voir line ~227.
        orderBy: { created_at: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.prospect.count({ where }),
    ]);

    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  // ============================================================
  // PHASE 2 — CALL CENTER
  // ============================================================

  /**
   * File d'appels J+1 (cahier §4.5) : contacts saisis AVANT aujourd'hui, encore
   * à traiter (Nouveau / À appeler / Non joignable recyclable), du plus ancien au
   * plus récent. + indicateurs du jour.
   */
  async getCallQueue(
    user: User,
    restaurantId?: string,
    startDate?: string,
    endDate?: string,
  ) {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const scope: Prisma.ProspectWhereInput = this.isStoreUser(user)
      ? { restaurant_id: user.restaurant_id! }
      : restaurantId
        ? { restaurant_id: restaurantId }
        : {};

    // Par défaut : tout le backlog J+1 et antérieur (créé avant aujourd'hui).
    // Si l'agent fournit une plage de dates (rattrapage d'un jour raté), on
    // cible précisément cette plage à la place — aujourd'hui inclus si voulu.
    const createdAtFilter: Prisma.DateTimeFilter =
      startDate || endDate
        ? {
            ...(startDate && { gte: new Date(startDate) }),
            ...(endDate && {
              lte: new Date(new Date(endDate).setHours(23, 59, 59, 999)),
            }),
          }
        : { lt: startOfToday };

    const where: Prisma.ProspectWhereInput = {
      entity_status: { not: EntityStatus.DELETED },
      status: {
        in: [
          ProspectStatus.NOUVEAU,
          ProspectStatus.A_APPELER,
          ProspectStatus.NON_JOIGNABLE,
        ],
      },
      created_at: createdAtFilter,
      ...scope,
    };

    const queue = await this.prisma.prospect.findMany({
      where,
      include: {
        restaurant: { select: { id: true, name: true } },
        _count: { select: { calls: true, messages: true } },
      },
      orderBy: { created_at: 'asc' },
      take: 200,
    });

    const [joinedToday, couponsToday] = await Promise.all([
      this.prisma.prospect.count({
        where: {
          entity_status: { not: EntityStatus.DELETED },
          status: ProspectStatus.JOINT,
          called_at: { gte: startOfToday },
          ...scope,
        },
      }),
      this.prisma.prospect.count({
        where: {
          entity_status: { not: EntityStatus.DELETED },
          coupon_sent_at: { gte: startOfToday },
          ...scope,
        },
      }),
    ]);

    return {
      queue,
      indicators: { toCall: queue.length, joinedToday, couponsToday },
    };
  }

  /** Fiche détaillée d'un contact + tout son historique (cahier §4.4). */
  async findOne(user: User, id: string) {
    const prospect = await this.prisma.prospect.findUnique({
      where: { id },
      include: {
        restaurant: { select: { id: true, name: true } },
        creator: { select: { id: true, fullname: true } },
        customer: {
          select: { id: true, first_name: true, last_name: true, phone: true },
        },
        promo_code: {
          select: {
            id: true,
            code: true,
            expiration_date: true,
            is_active: true,
            usage_count: true,
          },
        },
        calls: {
          orderBy: { created_at: 'desc' },
          include: { agent: { select: { id: true, fullname: true } } },
        },
        messages: { orderBy: { created_at: 'desc' } },
      },
    });

    if (!prospect || prospect.entity_status === EntityStatus.DELETED) {
      throw new NotFoundException('Contact introuvable');
    }
    if (this.isStoreUser(user) && prospect.restaurant_id !== user.restaurant_id) {
      throw new ForbiddenException('Accès non autorisé à ce contact');
    }
    return prospect;
  }

  /** Qualification d'un appel (joint / non joignable / refus). */
  async markCall(user: User, id: string, dto: MarkCallDto) {
    const prospect = await this.prisma.prospect.findUnique({ where: { id } });
    if (!prospect || prospect.entity_status === EntityStatus.DELETED) {
      throw new NotFoundException('Contact introuvable');
    }
    if (this.isStoreUser(user) && prospect.restaurant_id !== user.restaurant_id) {
      throw new ForbiddenException('Accès non autorisé à ce contact');
    }

    const rank =
      (await this.prisma.prospectCall.count({ where: { prospect_id: id } })) + 1;

    const statusByResult: Record<ProspectCallResult, ProspectStatus> = {
      JOINT: ProspectStatus.JOINT,
      NON_JOIGNABLE: ProspectStatus.NON_JOIGNABLE,
      REFUS: ProspectStatus.REFUS,
    };
    // Ne jamais rétrograder un contact déjà plus avancé dans l'entonnoir
    const locked: ProspectStatus[] = [
      ProspectStatus.COUPON_ENVOYE,
      ProspectStatus.INSCRIT,
      ProspectStatus.CONVERTI,
    ];
    const nextStatus = locked.includes(prospect.status)
      ? prospect.status
      : statusByResult[dto.result];

    const [, updated] = await this.prisma.$transaction([
      this.prisma.prospectCall.create({
        data: {
          prospect_id: id,
          agent_id: user.id,
          result: dto.result,
          rank,
          note: dto.note,
        },
      }),
      this.prisma.prospect.update({
        where: { id },
        data: {
          status: nextStatus,
          called_at: new Date(),
          // Horodate le 1er « joint » (entonnoir « vérifiés »)
          ...(dto.result === ProspectCallResult.JOINT && !prospect.joined_at
            ? { joined_at: new Date() }
            : {}),
        },
        include: { restaurant: { select: { id: true, name: true } } },
      }),
    ]);

    return updated;
  }

  /**
   * Génère + rattache un coupon (code promo à usage unique) puis l'envoie.
   * Verrou cahier §6.2 : uniquement après un appel « joint », un seul coupon actif.
   */
  async sendCoupon(user: User, id: string) {
    const prospect = await this.prisma.prospect.findUnique({ where: { id } });
    if (!prospect || prospect.entity_status === EntityStatus.DELETED) {
      throw new NotFoundException('Contact introuvable');
    }
    if (this.isStoreUser(user) && prospect.restaurant_id !== user.restaurant_id) {
      throw new ForbiddenException('Accès non autorisé à ce contact');
    }
    if (prospect.status !== ProspectStatus.JOINT) {
      throw new BadRequestException(
        "Le client doit d'abord être marqué « joint » avant l'envoi du coupon.",
      );
    }
    if (prospect.promo_code_id) {
      throw new BadRequestException('Un coupon a déjà été envoyé à ce contact.');
    }

    const cfg = await this.getCouponConfig();
    const now = new Date();
    const expiration = new Date(
      now.getTime() + cfg.validityDays * 24 * 60 * 60 * 1000,
    );

    // Code unique
    let code = this.generateCouponCode();
    for (let i = 0; i < 5; i++) {
      const exists = await this.prisma.promoCode.findUnique({ where: { code } });
      if (!exists) break;
      code = this.generateCouponCode();
    }

    // Génération via le système de codes promo EXISTANT (pas de système parallèle)
    const promo = await this.prisma.promoCode.create({
      data: {
        code,
        description: `Conversion Glovo/Yango — ${prospect.name}`,
        discount_type: cfg.discountType,
        discount_value: cfg.discountValue,
        min_order_amount: 0,
        max_usage: 1,
        max_usage_per_user: 1,
        start_date: now,
        expiration_date: expiration,
        is_active: true,
        restaurant_ids: [], // utilisable dans TOUS les restaurants Chicken Nation
        target_type: TargetType.ALL_PRODUCTS,
        created_by: user.id,
      },
    });

    // Message au rang adéquat (découverte / relance)
    const rank =
      (await this.prisma.prospectMessage.count({
        where: { prospect_id: id },
      })) + 1;
    const kind = this.kindForRank(rank);
    const body = await this.buildMessageBody(kind, {
      nom: prospect.name,
      code,
      validite: cfg.validityDays,
      lien: cfg.appLink,
    });

    // Envoi SMS (E.164 +225) AVANT d'enregistrer le message, pour tracer la délivrance.
    const sms = await this.twilio.sendSmsMessage({
      phoneNumber: this.toE164(prospect.phone),
      message: body,
    });
    const smsSent = !!sms;
    this.logger.log(
      `SMS coupon → to=${this.toE164(prospect.phone)} accepté=${smsSent} sid=${sms?.sid ?? '-'} statut=${sms?.status ?? '-'} errCode=${sms?.errorCode ?? '-'} errMsg=${sms?.errorMessage ?? '-'}`,
    );

    const [updated] = await this.prisma.$transaction([
      this.prisma.prospect.update({
        where: { id },
        data: {
          promo_code_id: promo.id,
          status: ProspectStatus.COUPON_ENVOYE,
          coupon_sent_at: now,
        },
        include: {
          restaurant: { select: { id: true, name: true } },
          promo_code: {
            select: { id: true, code: true, expiration_date: true },
          },
        },
      }),
      this.prisma.prospectMessage.create({
        data: { prospect_id: id, kind, rank, body, sms_sent: smsSent },
      }),
    ]);

    return {
      prospect: updated,
      coupon: { code: promo.code, expiration_date: promo.expiration_date },
      message: body,
      smsSent,
    };
  }

  /** Renvoie le SMS du coupon EXISTANT (sans en générer un nouveau). */
  async resendCoupon(user: User, id: string) {
    const prospect = await this.prisma.prospect.findUnique({
      where: { id },
      include: { promo_code: { select: { code: true } } },
    });
    if (!prospect || prospect.entity_status === EntityStatus.DELETED) {
      throw new NotFoundException('Contact introuvable');
    }
    if (this.isStoreUser(user) && prospect.restaurant_id !== user.restaurant_id) {
      throw new ForbiddenException('Accès non autorisé à ce contact');
    }
    if (!prospect.promo_code_id || !prospect.promo_code) {
      throw new BadRequestException('Aucun coupon à renvoyer pour ce contact.');
    }

    const cfg = await this.getCouponConfig();
    const rank =
      (await this.prisma.prospectMessage.count({ where: { prospect_id: id } })) +
      1;
    const kind = this.kindForRank(rank);
    const body = await this.buildMessageBody(kind, {
      nom: prospect.name,
      code: prospect.promo_code.code,
      validite: cfg.validityDays,
      lien: cfg.appLink,
    });

    const sms = await this.twilio.sendSmsMessage({
      phoneNumber: this.toE164(prospect.phone),
      message: body,
    });
    const smsSent = !!sms;
    this.logger.log(
      `Renvoi SMS coupon → to=${this.toE164(prospect.phone)} accepté=${smsSent} sid=${sms?.sid ?? '-'} statut=${sms?.status ?? '-'} errCode=${sms?.errorCode ?? '-'} errMsg=${sms?.errorMessage ?? '-'}`,
    );

    await this.prisma.prospectMessage.create({
      data: { prospect_id: id, kind, rank, body, sms_sent: smsSent },
    });

    return { smsSent, message: body, code: prospect.promo_code.code };
  }

  // ============================================================
  // PHASE 3 — ANALYTICS
  // ============================================================

  private scopeFor(user: User, restaurantId?: string): Prisma.ProspectWhereInput {
    if (this.isStoreUser(user)) return { restaurant_id: user.restaurant_id! };
    if (restaurantId) return { restaurant_id: restaurantId };
    return {};
  }

  /** KPIs + entonnoir + répartition (cahier §4.1 / §8). */
  async getStats(user: User, restaurantId?: string) {
    const base: Prisma.ProspectWhereInput = {
      entity_status: { not: EntityStatus.DELETED },
      ...this.scopeFor(user, restaurantId),
    };
    const c = (where: Prisma.ProspectWhereInput) =>
      this.prisma.prospect.count({ where: { ...base, ...where } });

    const [
      total,
      verifies,
      couponEnvoye,
      inscrits,
      convertis,
      glovo,
      yango,
      couponsUsed,
      caAgg,
    ] = await Promise.all([
      c({}),
      c({ joined_at: { not: null } }),
      c({ coupon_sent_at: { not: null } }),
      c({ registered_at: { not: null } }),
      c({ converted_at: { not: null } }),
      c({ platform: ProspectPlatform.GLOVO }),
      c({ platform: ProspectPlatform.YANGO }),
      c({ promo_code_id: { not: null }, converted_at: { not: null } }),
      this.prisma.prospect.aggregate({
        where: { ...base, converted_at: { not: null } },
        _sum: { first_order_amount: true },
      }),
    ]);
    const ca = caAgg._sum.first_order_amount ?? 0;

    const [byStoreRaw, convByStoreRaw] = await Promise.all([
      this.prisma.prospect.groupBy({
        by: ['restaurant_id'],
        where: base,
        _count: { _all: true },
      }),
      this.prisma.prospect.groupBy({
        by: ['restaurant_id'],
        where: { ...base, converted_at: { not: null } },
        _count: { _all: true },
      }),
    ]);
    const restos = await this.prisma.restaurant.findMany({
      where: { id: { in: byStoreRaw.map((r) => r.restaurant_id) } },
      select: { id: true, name: true },
    });
    const nameById = new Map(restos.map((r) => [r.id, r.name]));
    const convById = new Map(
      convByStoreRaw.map((r) => [r.restaurant_id, r._count._all]),
    );
    const by_store = byStoreRaw
      .map((r) => ({
        restaurant_id: r.restaurant_id,
        name: nameById.get(r.restaurant_id) ?? '—',
        total: r._count._all,
        converted: convById.get(r.restaurant_id) ?? 0,
      }))
      .sort((a, b) => b.total - a.total);

    return {
      total,
      funnel: {
        saisis: total,
        verifies,
        coupon_envoye: couponEnvoye,
        inscrits,
        convertis,
      },
      platform: { glovo, yango },
      conversion_rate: total ? Math.round((convertis / total) * 100) : 0,
      coupons: {
        sent: couponEnvoye,
        used: couponsUsed,
        usage_rate: couponEnvoye
          ? Math.round((couponsUsed / couponEnvoye) * 100)
          : 0,
      },
      sales: {
        count: convertis,
        ca,
        average: convertis ? Math.round(ca / convertis) : 0,
      },
      by_store,
    };
  }

  /** Suivi des coupons émis (cahier §4.6). */
  async getCoupons(user: User, restaurantId?: string) {
    const rows = await this.prisma.prospect.findMany({
      where: {
        entity_status: { not: EntityStatus.DELETED },
        promo_code_id: { not: null },
        ...this.scopeFor(user, restaurantId),
      },
      include: {
        restaurant: { select: { id: true, name: true } },
        promo_code: { select: { code: true, expiration_date: true } },
      },
      orderBy: { coupon_sent_at: 'desc' },
      take: 500,
    });
    const now = new Date();
    return rows.map((p) => {
      const used = !!p.converted_at;
      const expired =
        !used && p.promo_code?.expiration_date
          ? p.promo_code.expiration_date < now
          : false;
      return {
        id: p.id,
        code: p.promo_code?.code ?? '—',
        name: p.name,
        platform: p.platform,
        restaurant: p.restaurant,
        sent_at: p.coupon_sent_at,
        expiration_date: p.promo_code?.expiration_date ?? null,
        state: used ? 'USED' : expired ? 'EXPIRED' : 'ACTIVE',
      };
    });
  }

  /** Ventes attribuées à l'opération (cahier §4.7). */
  async getSales(user: User, restaurantId?: string) {
    const rows = await this.prisma.prospect.findMany({
      where: {
        entity_status: { not: EntityStatus.DELETED },
        converted_at: { not: null },
        ...this.scopeFor(user, restaurantId),
      },
      include: {
        restaurant: { select: { id: true, name: true } },
        promo_code: { select: { code: true } },
      },
      orderBy: { converted_at: 'desc' },
      take: 500,
    });
    const ca = rows.reduce((s, p) => s + (p.first_order_amount ?? 0), 0);
    const data = rows.map((p) => ({
      id: p.id,
      name: p.name,
      platform: p.platform,
      restaurant: p.restaurant,
      coupon: p.promo_code?.code ?? null,
      amount: p.first_order_amount ?? 0,
      date: p.converted_at,
    }));
    return {
      data,
      totals: {
        count: rows.length,
        ca,
        average: rows.length ? Math.round(ca / rows.length) : 0,
      },
    };
  }

  // ============================================================
  // PHASE 4 — RÉGLAGES & EXPORTS
  // ============================================================

  /** Réglages courants du module (avec valeurs par défaut). */
  async getSettings() {
    const v = await this.settings.getMany([
      'prospect.coupon_validity_days',
      'prospect.coupon_discount_type',
      'prospect.coupon_discount_value',
      'prospect.app_link',
      'prospect.msg.decouverte',
      'prospect.msg.relance_1',
      'prospect.msg.relance_2',
      'prospect.scan_engine',
      'prospect.scan_api_key',
      'prospect.scan_model',
    ]);
    return {
      coupon_validity_days:
        Number(v['prospect.coupon_validity_days']) > 0
          ? Number(v['prospect.coupon_validity_days'])
          : 7,
      coupon_discount_type:
        v['prospect.coupon_discount_type'] === 'FIXED_AMOUNT'
          ? 'FIXED_AMOUNT'
          : 'PERCENTAGE',
      coupon_discount_value:
        Number(v['prospect.coupon_discount_value']) > 0
          ? Number(v['prospect.coupon_discount_value'])
          : 10,
      app_link: v['prospect.app_link'] || DEFAULT_APP_LINK,
      msg_decouverte: v['prospect.msg.decouverte'] || DEFAULT_MESSAGES.DECOUVERTE,
      msg_relance_1: v['prospect.msg.relance_1'] || DEFAULT_MESSAGES.RELANCE_1,
      msg_relance_2:
        v['prospect.msg.relance_2'] || DEFAULT_MESSAGES.RELANCE_2_FIDELITE,
      scan_engine: v['prospect.scan_engine'] || 'TESSERACT',
      scan_api_key: v['prospect.scan_api_key'] || '',
      scan_model: v['prospect.scan_model'] || '',
    };
  }

  /** Met à jour les réglages (upsert dans `settings`). */
  async updateSettings(dto: UpdateProspectSettingsDto) {
    const set = async (k: string, val: string | undefined) => {
      if (val !== undefined && val !== null) await this.settings.set(k, val);
    };
    await set(
      'prospect.coupon_validity_days',
      dto.coupon_validity_days != null ? String(dto.coupon_validity_days) : undefined,
    );
    await set('prospect.coupon_discount_type', dto.coupon_discount_type);
    await set(
      'prospect.coupon_discount_value',
      dto.coupon_discount_value != null ? String(dto.coupon_discount_value) : undefined,
    );
    await set('prospect.app_link', dto.app_link);
    await set('prospect.msg.decouverte', dto.msg_decouverte);
    await set('prospect.msg.relance_1', dto.msg_relance_1);
    await set('prospect.msg.relance_2', dto.msg_relance_2);
    await set('prospect.scan_engine', dto.scan_engine);
    await set('prospect.scan_api_key', dto.scan_api_key);
    await set('prospect.scan_model', dto.scan_model);
    return this.getSettings();
  }

  /** Export CSV (contacts | coupons | sales). */
  async exportCsv(
    user: User,
    type: string,
    restaurantId?: string,
  ): Promise<string> {
    if (type === 'coupons') {
      const rows = await this.getCoupons(user, restaurantId);
      return this.toCsv(
        ['Code', 'Contact', 'Plateforme', 'Emis le', 'Expire le', 'Store', 'Etat'],
        rows.map((r) => [
          r.code,
          r.name,
          r.platform,
          this.csvDate(r.sent_at),
          this.csvDate(r.expiration_date),
          r.restaurant?.name ?? '',
          r.state,
        ]),
      );
    }
    if (type === 'sales') {
      const { data } = await this.getSales(user, restaurantId);
      return this.toCsv(
        ['Date', 'Client', 'Plateforme', 'Coupon', 'Store', 'Montant'],
        data.map((r) => [
          this.csvDate(r.date),
          r.name,
          r.platform,
          r.coupon ?? '',
          r.restaurant?.name ?? '',
          String(r.amount),
        ]),
      );
    }
    // contacts (défaut) — même ordre que la table : plus récents en premier.
    const rows = await this.prisma.prospect.findMany({
      where: {
        entity_status: { not: EntityStatus.DELETED },
        ...this.scopeFor(user, restaurantId),
      },
      include: { restaurant: { select: { name: true } } },
      orderBy: { created_at: 'desc' },
      take: 5000,
    });
    return this.toCsv(
      ['Date', 'Plateforme', 'Nom', 'N commande', 'Telephone', 'Store', 'Statut'],
      rows.map((p) => [
        this.csvDate(p.created_at),
        p.platform,
        p.name,
        p.order_number,
        p.phone,
        p.restaurant?.name ?? '',
        p.status,
      ]),
    );
  }

  private csvDate(d?: Date | string | null): string {
    if (!d) return '';
    const date = typeof d === 'string' ? new Date(d) : d;
    try {
      return date.toISOString().slice(0, 16).replace('T', ' ');
    } catch {
      return '';
    }
  }

  private csvCell(v: string): string {
    const s = v == null ? '' : String(v);
    return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  private toCsv(headers: string[], rows: string[][]): string {
    return [headers, ...rows]
      .map((r) => r.map((c) => this.csvCell(c)).join(';'))
      .join('\n');
  }

  // ---------- Helpers coupon / messages ----------

  private async getCouponConfig() {
    const [days, type, value, link] = await Promise.all([
      this.settings.get('prospect.coupon_validity_days'),
      this.settings.get('prospect.coupon_discount_type'),
      this.settings.get('prospect.coupon_discount_value'),
      this.settings.get('prospect.app_link'),
    ]);
    const validityDays = Number(days) > 0 ? Number(days) : 7;
    const discountType =
      type === 'FIXED_AMOUNT'
        ? DiscountType.FIXED_AMOUNT
        : DiscountType.PERCENTAGE;
    const discountValue = Number(value) > 0 ? Number(value) : 10;
    const appLink = link || DEFAULT_APP_LINK;
    return { validityDays, discountType, discountValue, appLink };
  }

  private generateCouponCode(): string {
    const rnd = Math.random().toString(36).slice(2, 8).toUpperCase();
    return `CN-${rnd}`;
  }

  /** Numéro ivoirien au format E.164 pour Twilio : 225 + 10 chiffres (le + est ajouté par formatNumber). */
  private toE164(phone: string): string {
    const d = (phone || '').replace(/\D/g, '').slice(-10);
    return `225${d}`;
  }

  private kindForRank(rank: number): ProspectMessageKind {
    if (rank <= 1) return ProspectMessageKind.DECOUVERTE;
    if (rank === 2) return ProspectMessageKind.RELANCE_1;
    return ProspectMessageKind.RELANCE_2_FIDELITE;
  }

  private async buildMessageBody(
    kind: ProspectMessageKind,
    vars: { nom: string; code: string; validite: number; lien: string },
  ): Promise<string> {
    const keyByKind: Record<ProspectMessageKind, string> = {
      DECOUVERTE: 'prospect.msg.decouverte',
      RELANCE_1: 'prospect.msg.relance_1',
      RELANCE_2_FIDELITE: 'prospect.msg.relance_2',
    };
    const tpl = (await this.settings.get(keyByKind[kind])) || DEFAULT_MESSAGES[kind];
    // Repli si pas de nom (cas Yango) : évite « Bonjour  ! »
    const nom =
      vars.nom && vars.nom.trim() && vars.nom.trim().toLowerCase() !== 'client'
        ? vars.nom.trim()
        : 'cher client';
    return tpl
      .split('{nom}').join(nom)
      .split('{code_coupon}').join(vars.code)
      .split('{validite}').join(String(vars.validite))
      .split('{lien_app}').join(vars.lien);
  }
}
