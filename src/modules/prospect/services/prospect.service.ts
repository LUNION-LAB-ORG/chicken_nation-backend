import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  CrmCallOutcome,
  CrmSegment,
  CrmStatus,
  EntityStatus,
  Prisma,
  ProspectCallResult,
  ProspectMessageKind,
  ProspectStatus,
  User,
  UserType,
} from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from 'src/database/services/prisma.service';
import { CrmCallService } from 'src/modules/crm/services/crm-call.service';
import { CrmCaptureService } from 'src/modules/crm/services/crm-capture.service';
import { CrmCouponService } from 'src/modules/crm/services/crm-coupon.service';
import { SettingsService } from 'src/modules/settings/settings.service';
import { CreateProspectDto } from '../dto/create-prospect.dto';
import { MarkCallDto } from '../dto/mark-call.dto';
import { UpdateProspectSettingsDto } from '../dto/update-prospect-settings.dto';

/** Issue CRM de chaque résultat d'appel de l'ancienne file. */
const ISSUE_DU_RESULTAT: Record<ProspectCallResult, CrmCallOutcome> = {
  JOINT: CrmCallOutcome.INTERESSE,
  NON_JOIGNABLE: CrmCallOutcome.NON_JOINT,
  REFUS: CrmCallOutcome.NON_INTERESSE,
};

/**
 * Captures Glovo/Yango (caissiers, gérants) et anciennes routes de l'appli
 * caisse.
 *
 * Depuis le CRM (lot 2), une capture rejoint aussitôt la fiche de son numéro
 * dans le CRM. Les appels et les coupons de l'ancienne file J+1 passent par le
 * CRM (mêmes règles, même prise de la fiche, mêmes refus) : ces routes ne
 * servent plus qu'à l'appli caisse pas encore mise à jour, et disparaîtront
 * ensuite. Les anciennes lignes restent tenues à jour pour qu'elle s'affiche
 * correctement d'ici là.
 */
@Injectable()
export class ProspectService {
  private readonly logger = new Logger(ProspectService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly crmCapture: CrmCaptureService,
    private readonly crmAppels: CrmCallService,
    private readonly crmCoupons: CrmCouponService,
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
    const restaurantId = this.isStoreUser(user) ? user.restaurant_id! : dto.restaurant_id;
    if (!restaurantId) {
      throw new BadRequestException('Le store (restaurant) est obligatoire pour enregistrer un contact.');
    }

    // Le MÊME client peut être saisi plusieurs fois (une fiche par numéro dans
    // le CRM), mais pas DEUX FOIS la même commande dans ce restaurant.
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
        throw new BadRequestException(`La commande ${dto.platform} n° ${orderNumber} a déjà été enregistrée.`);
      }
    }

    const capture = await this.prisma.prospect.create({
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
    // Jamais bloquant : en cas de souci, la reprise rattache dans les 10 minutes.
    const contactId = await this.crmCapture.rattacherCapture(capture.id);
    return { ...capture, contact_id: contactId };
  }

  /**
   * Détection de doublon par téléphone AVANT saisie (« doublon possible »).
   * Cloisonné au store pour un agent store.
   */
  async checkPhone(user: User, phone: string) {
    const cleaned = (phone || '').replace(/\D/g, '');
    if (cleaned.length < 6 || cleaned.length > 15) return { exists: false, prospect: null };

    const where: Prisma.ProspectWhereInput = { phone: cleaned, entity_status: { not: EntityStatus.DELETED } };
    if (this.isStoreUser(user)) where.restaurant_id = user.restaurant_id!;

    const existing = await this.prisma.prospect.findFirst({
      where,
      orderBy: { created_at: 'desc' },
      include: { restaurant: { select: { id: true, name: true } } },
    });
    return {
      exists: !!existing,
      prospect: existing
        ? { id: existing.id, name: existing.name, status: existing.status, restaurant: existing.restaurant, created_at: existing.created_at }
        : null,
    };
  }

  /**
   * Ancienne file J+1 de l'appli caisse, lue dans le CRM (seule source de
   * vérité) : les fiches Glovo/Yango ouvertes, hors campagne, sans coupon
   * actif, à l'agent ou encore dans la file commune (captées avant aujourd'hui),
   * un rappel promis n'y revenant qu'à son heure. Une carte par fiche, avec sa
   * dernière capture : c'est elle que l'ancienne appli qualifie. Les conditions
   * sont dans la requête, avant la limite : une fiche déjà traitée ne peut plus
   * occuper une place de la file.
   */
  async getCallQueue(user: User, restaurantId?: string, startDate?: string, endDate?: string) {
    const maintenant = new Date();
    const debutDuJour = new Date(`${maintenant.toISOString().slice(0, 10)}T00:00:00.000Z`);
    const scope: Prisma.ProspectWhereInput = this.isStoreUser(user)
      ? { restaurant_id: user.restaurant_id! }
      : restaurantId
        ? { restaurant_id: restaurantId }
        : {};
    const periode: Prisma.DateTimeFilter | undefined =
      startDate || endDate
        ? {
            ...(startDate && { gte: new Date(startDate) }),
            ...(endDate && { lte: new Date(new Date(endDate).setHours(23, 59, 59, 999)) }),
          }
        : undefined;
    const capturesVisibles: Prisma.ProspectWhereInput = {
      entity_status: { not: EntityStatus.DELETED },
      platform: { in: ['GLOVO', 'YANGO'] },
      ...scope,
      ...(periode && { created_at: periode }),
    };

    const fiches = await this.prisma.crmContact.findMany({
      where: {
        entity_status: { not: EntityStatus.DELETED },
        segment: { in: [CrmSegment.GLOVO, CrmSegment.YANGO] },
        status: { in: [CrmStatus.A_APPELER, CrmStatus.A_RAPPELER, CrmStatus.INTERESSE] },
        campaign_id: null,
        coupons: { none: { used_at: null, expires_at: { gt: maintenant } } },
        captures: { some: capturesVisibles },
        AND: [
          { OR: [{ assigned_to_id: user.id }, { assigned_to_id: null, segment_since: { lt: debutDuJour } }] },
          { OR: [{ status: { not: CrmStatus.A_RAPPELER } }, { callback_at: null }, { callback_at: { lte: maintenant } }] },
        ],
      },
      select: {
        status: true,
        call_count: true,
        captures: {
          where: capturesVisibles,
          orderBy: { created_at: 'desc' },
          take: 1,
          include: { restaurant: { select: { id: true, name: true } }, _count: { select: { messages: true } } },
        },
      },
      orderBy: { segment_since: 'asc' },
      take: 200,
    });

    // Statut affiché par l'ancienne appli, déduit de la fiche.
    const statutAffiche = (f: { status: CrmStatus; call_count: number }): ProspectStatus =>
      f.status === CrmStatus.INTERESSE
        ? ProspectStatus.JOINT
        : f.status === CrmStatus.A_RAPPELER
          ? ProspectStatus.A_APPELER
          : f.call_count > 0
            ? ProspectStatus.NON_JOIGNABLE
            : ProspectStatus.NOUVEAU;
    const queue = fiches
      .filter((f) => f.captures.length > 0)
      .map((f) => {
        const { _count, ...capture } = f.captures[0];
        return { ...capture, status: statutAffiche(f), _count: { calls: f.call_count, messages: _count.messages } };
      });

    // Indicateurs du jour, lus dans le CRM : un appel ou un coupon fait au backoffice compte aussi.
    const [joinedToday, couponsToday] = await Promise.all([
      this.prisma.crmCall.count({
        where: { reached: true, created_at: { gte: debutDuJour }, segment: { in: [CrmSegment.GLOVO, CrmSegment.YANGO] } },
      }),
      this.prisma.crmCoupon.count({
        where: { sent_at: { gte: debutDuJour }, segment: { in: [CrmSegment.GLOVO, CrmSegment.YANGO] } },
      }),
    ]);
    return { queue, indicators: { toCall: queue.length, joinedToday, couponsToday } };
  }

  /** Fiche détaillée d'une capture et de son ancien historique (appli caisse). */
  async findOne(user: User, id: string) {
    const prospect = await this.prisma.prospect.findUnique({
      where: { id },
      include: {
        restaurant: { select: { id: true, name: true } },
        creator: { select: { id: true, fullname: true } },
        customer: { select: { id: true, first_name: true, last_name: true, phone: true } },
        promo_code: { select: { id: true, code: true, expiration_date: true, is_active: true, usage_count: true } },
        calls: { orderBy: { created_at: 'desc' }, include: { agent: { select: { id: true, fullname: true } } } },
        messages: { orderBy: { created_at: 'desc' } },
      },
    });
    if (!prospect || prospect.entity_status === EntityStatus.DELETED) throw new NotFoundException('Contact introuvable');
    if (this.isStoreUser(user) && prospect.restaurant_id !== user.restaurant_id) {
      throw new ForbiddenException('Accès non autorisé à ce contact');
    }
    return prospect;
  }

  /** Qualification d'un appel de l'ancienne file : enregistrée dans le CRM, puis recopiée. */
  async markCall(user: User, id: string, dto: MarkCallDto) {
    const capture = await this.chargerCapture(user, id);
    const contactId = await this.ficheDe(capture);
    const outcome = ISSUE_DU_RESULTAT[dto.result];
    const statut = await this.prisma.crmCallStatus.findFirst({
      where: { outcome, is_active: true, entity_status: { not: EntityStatus.DELETED } },
      orderBy: { position: 'asc' },
      select: { id: true },
    });
    if (!statut) throw new BadRequestException("Aucun statut d'appel correspondant n'est actif dans les réglages du CRM");

    const maintenant = new Date();
    const rank = (await this.prisma.prospectCall.count({ where: { prospect_id: id } })) + 1;
    const prospectCallId = randomUUID();
    await this.prisma.prospectCall.create({
      data: { id: prospectCallId, prospect_id: id, agent_id: user.id, result: dto.result, rank, note: dto.note, created_at: maintenant },
    });
    // Mêmes règles que le CRM : prise de la fiche, refus si un collègue l'a.
    // L'ancienne ligne d'appel doit exister avant (clé du CrmCall) ; un refus
    // du CRM la retire, sinon elle resterait comme un appel fantôme.
    try {
      await this.crmAppels.enregistrer(
        user,
        contactId,
        { call_status_id: statut.id, comment: dto.note },
        { sansRaison: true, prospectCallId, date: maintenant },
      );
    } catch (e) {
      await this.prisma.prospectCall.delete({ where: { id: prospectCallId } }).catch(() => undefined);
      throw e;
    }

    const bloques: ProspectStatus[] = [ProspectStatus.COUPON_ENVOYE, ProspectStatus.INSCRIT, ProspectStatus.CONVERTI];
    const suivant: Record<ProspectCallResult, ProspectStatus> = {
      JOINT: ProspectStatus.JOINT,
      NON_JOIGNABLE: ProspectStatus.NON_JOIGNABLE,
      REFUS: ProspectStatus.REFUS,
    };
    return this.prisma.prospect.update({
      where: { id },
      data: {
        status: bloques.includes(capture.status) ? capture.status : suivant[dto.result],
        called_at: maintenant,
        ...(dto.result === ProspectCallResult.JOINT && !capture.joined_at && { joined_at: maintenant }),
      },
      include: { restaurant: { select: { id: true, name: true } } },
    });
  }

  /** Coupon depuis l'ancienne file : créé et envoyé par le CRM (un seul coupon actif par personne). */
  async sendCoupon(user: User, id: string) {
    const capture = await this.chargerCapture(user, id);
    const contactId = await this.ficheDe(capture);
    const envoi = await this.crmCoupons.envoyer(user, contactId, {});
    const maintenant = new Date();
    const rank = (await this.prisma.prospectMessage.count({ where: { prospect_id: id } })) + 1;
    const [prospect] = await this.prisma.$transaction([
      this.prisma.prospect.update({
        where: { id },
        data: { promo_code_id: envoi.coupon.promo_code_id, status: ProspectStatus.COUPON_ENVOYE, coupon_sent_at: maintenant },
        include: { restaurant: { select: { id: true, name: true } } },
      }),
      this.prisma.prospectMessage.create({
        data: { prospect_id: id, kind: ProspectMessageKind.DECOUVERTE, rank, body: envoi.message, sms_sent: envoi.envoye },
      }),
    ]);
    return {
      prospect,
      coupon: { code: envoi.coupon.code, expiration_date: envoi.coupon.expires_at },
      message: envoi.message,
      smsSent: envoi.envoye,
    };
  }

  /** Renvoi du coupon depuis l'ancienne file : seulement celui de cette capture. */
  async resendCoupon(user: User, id: string) {
    const capture = await this.chargerCapture(user, id);
    const contactId = await this.ficheDe(capture);
    const code = capture.promo_code_id
      ? (await this.prisma.promoCode.findUnique({ where: { id: capture.promo_code_id }, select: { code: true } }))?.code
      : undefined;
    if (!code) throw new BadRequestException('Aucun coupon à renvoyer pour ce contact.');
    const envoi = await this.crmCoupons.renvoyer(user, contactId, { codeAttendu: code });
    const rank = (await this.prisma.prospectMessage.count({ where: { prospect_id: id } })) + 1;
    await this.prisma.prospectMessage.create({
      data: { prospect_id: id, kind: ProspectMessageKind.RELANCE_1, rank, body: envoi.message, sms_sent: envoi.envoye },
    });
    return { smsSent: envoi.envoye, message: envoi.message, code: envoi.code };
  }

  private async chargerCapture(user: User, id: string) {
    const capture = await this.prisma.prospect.findUnique({ where: { id } });
    if (!capture || capture.entity_status === EntityStatus.DELETED) throw new NotFoundException('Contact introuvable');
    if (this.isStoreUser(user) && capture.restaurant_id !== user.restaurant_id) {
      throw new ForbiddenException('Accès non autorisé à ce contact');
    }
    return capture;
  }

  private async ficheDe(capture: { id: string; contact_id: string | null }): Promise<string> {
    const contactId = capture.contact_id ?? (await this.crmCapture.rattacherCapture(capture.id));
    if (!contactId) {
      throw new ConflictException('Ce contact est en cours de reprise dans le CRM : réessayez dans quelques minutes');
    }
    return contactId;
  }

  // ============================================================
  // RÉGLAGES DU SCAN (la remise et les messages sont dans le CRM)
  // ============================================================

  async getSettings() {
    const v = await this.settings.getMany(['prospect.scan_engine', 'prospect.scan_api_key', 'prospect.scan_model']);
    return {
      scan_engine: v['prospect.scan_engine'] || 'TESSERACT',
      // Write-only comme les autres secrets : l'écriture d'un masque est sans effet.
      scan_api_key: v['prospect.scan_api_key'] ? SettingsService.MASK : '',
      scan_model: v['prospect.scan_model'] || '',
    };
  }

  async updateSettings(dto: UpdateProspectSettingsDto) {
    if (dto.scan_engine !== undefined) await this.settings.set('prospect.scan_engine', dto.scan_engine);
    if (dto.scan_api_key !== undefined) await this.settings.set('prospect.scan_api_key', dto.scan_api_key);
    if (dto.scan_model !== undefined) await this.settings.set('prospect.scan_model', dto.scan_model);
    return this.getSettings();
  }
}
