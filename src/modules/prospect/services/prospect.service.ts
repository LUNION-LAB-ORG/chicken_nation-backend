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

    return this.prisma.prospect.create({
      data: {
        platform: dto.platform,
        name: dto.name,
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
    if (cleaned.length !== 10) {
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
        orderBy: { created_at: 'asc' },
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
  async getCallQueue(user: User, restaurantId?: string) {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const scope: Prisma.ProspectWhereInput = this.isStoreUser(user)
      ? { restaurant_id: user.restaurant_id! }
      : restaurantId
        ? { restaurant_id: restaurantId }
        : {};

    const where: Prisma.ProspectWhereInput = {
      entity_status: { not: EntityStatus.DELETED },
      status: {
        in: [
          ProspectStatus.NOUVEAU,
          ProspectStatus.A_APPELER,
          ProspectStatus.NON_JOIGNABLE,
        ],
      },
      created_at: { lt: startOfToday },
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
        data: { status: nextStatus, called_at: new Date() },
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
        restaurant_ids: [prospect.restaurant_id],
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
        data: { prospect_id: id, kind, rank, body },
      }),
    ]);

    // Envoi best-effort (SMS) — ne bloque jamais le flux
    try {
      await this.twilio.sendSmsMessage({ phoneNumber: prospect.phone, message: body });
    } catch (e) {
      this.logger.warn(
        `Envoi SMS coupon échoué pour ${prospect.phone}: ${(e as Error)?.message}`,
      );
    }

    return {
      prospect: updated,
      coupon: { code: promo.code, expiration_date: promo.expiration_date },
      message: body,
    };
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
    const appLink = link || 'https://chicken.turbodeliveryapp.com';
    return { validityDays, discountType, discountValue, appLink };
  }

  private generateCouponCode(): string {
    const rnd = Math.random().toString(36).slice(2, 8).toUpperCase();
    return `CN-${rnd}`;
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
    const defaults: Record<ProspectMessageKind, string> = {
      DECOUVERTE:
        'Bonjour {nom} ! Merci de commander chez Chicken Nation 🍗 Commandez désormais en direct sur notre app et payez moins cher. Votre code promo {code_coupon} (valable {validite} jours). Lien : {lien_app}',
      RELANCE_1:
        "Re-bonjour {nom} ! Profitez encore de tarifs réduits sur l'app Chicken Nation : {lien_app}. Code {code_coupon} (valable {validite} jours).",
      RELANCE_2_FIDELITE:
        "{nom}, merci pour votre fidélité ! 🎁 Offre exclusive sur l'app : {lien_app}. Votre code {code_coupon} (valable {validite} jours).",
    };
    const tpl = (await this.settings.get(keyByKind[kind])) || defaults[kind];
    return tpl
      .split('{nom}').join(vars.nom)
      .split('{code_coupon}').join(vars.code)
      .split('{validite}').join(String(vars.validite))
      .split('{lien_app}').join(vars.lien);
  }
}
