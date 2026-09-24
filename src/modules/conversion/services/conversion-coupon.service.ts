import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  CampaignStatus,
  ConversionCouponChannel,
  ConversionEventType,
  ConversionProspectStatus,
  EntityStatus,
  TargetType,
  User,
} from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { TwilioService } from 'src/twilio/services/twilio.service';
import {
  dateCourte,
  genererCodeCoupon,
  prenomPourMessage,
  remplirModele,
  versE164,
} from '../conversion.rules';
import { SendCouponDto } from '../dto/prospect.dto';
import { ConversionAccessService } from './conversion-access.service';
import { ConversionConfigService } from './conversion-config.service';
import { ConversionEventsService } from './conversion-events.service';
import { nomClient } from './conversion-prospect.query';

const LIBELLE_CANAL: Record<ConversionCouponChannel, string> = {
  WHATSAPP: 'envoyé par WhatsApp',
  SMS: 'envoyé par SMS',
  AUCUN: "créé, mais aucun message n'est parti",
};

/**
 * Coupons de bienvenue (cahier §5 et §8). Chaque coupon est un vrai code promo
 * à usage unique : c'est lui que la caisse et l'application acceptent, et
 * c'est par lui qu'une commande se rattache automatiquement au prospect.
 */
@Injectable()
export class ConversionCouponService {
  private readonly logger = new Logger(ConversionCouponService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ConversionAccessService,
    private readonly config: ConversionConfigService,
    private readonly events: ConversionEventsService,
    private readonly twilio: TwilioService,
  ) {}

  async envoyer(user: User, prospectId: string, dto: SendCouponDto) {
    const prospect = await this.chargerProspect(user, prospectId);
    if (prospect.status === ConversionProspectStatus.INJOIGNABLE) {
      throw new BadRequestException("Ce numéro est injoignable : aucun message ne pourrait partir");
    }
    const maintenant = new Date();
    const actif = await this.prisma.conversionCoupon.findFirst({
      where: { prospect_id: prospect.id, used_at: null, expires_at: { gt: maintenant } },
      select: { code: true, expires_at: true },
    });
    if (actif) {
      throw new BadRequestException(
        `Un coupon est déjà actif (${actif.code}, jusqu'au ${dateCourte(actif.expires_at)}). Renvoyez-le plutôt que d'en créer un second.`,
      );
    }

    const reglages = await this.config.lireReglages();
    const offre = await this.choisirOffre([dto.offer_id, prospect.campaign?.offer_id, reglages.default_offer_id]);
    const code = await this.codeLibre();
    const expiration = new Date(maintenant.getTime() + offre.validity_days * 86_400_000);
    const campagneId =
      prospect.campaign_id && prospect.campaign?.status !== CampaignStatus.COMPLETED ? prospect.campaign_id : null;

    const coupon = await this.prisma.$transaction(async (tx) => {
      const claim = await tx.conversionProspect.updateMany({
        where: { id: prospect.id, status: { not: ConversionProspectStatus.CONVERTI } },
        data: { status: ConversionProspectStatus.COUPON_ENVOYE, coupon_sent_at: maintenant, callback_at: null },
      });
      if (claim.count === 0) throw new BadRequestException('Ce client vient de passer sa première commande');
      const promo = await tx.promoCode.create({
        data: {
          code,
          description: `Prospect ${nomClient(prospect.customer)} : ${offre.label}`,
          discount_type: offre.discount_type,
          discount_value: offre.discount_value,
          max_discount_amount: offre.max_discount_amount,
          min_order_amount: offre.min_order_amount,
          max_usage: 1,
          max_usage_per_user: 1,
          start_date: maintenant,
          expiration_date: expiration,
          is_active: true,
          restaurant_ids: [],
          target_type: TargetType.ALL_PRODUCTS,
          created_by: user.id,
        },
      });
      return tx.conversionCoupon.create({
        data: {
          prospect_id: prospect.id,
          campaign_id: campagneId,
          offer_id: offre.id,
          promo_code_id: promo.id,
          code,
          offer_label: offre.label,
          discount_type: offre.discount_type,
          discount_value: offre.discount_value,
          sent_by_id: user.id,
          sent_at: maintenant,
          expires_at: expiration,
        },
      });
    });

    // Le message part APRÈS l'enregistrement : jamais de code envoyé qui
    // n'existerait pas en base.
    const envoi = await this.expedier(prospect.customer, coupon, reglages);
    await this.prisma.conversionCoupon.update({
      where: { id: coupon.id },
      data: { channel: envoi.canal, message_sid: envoi.sid, send_error: envoi.erreur },
    });
    await this.events.journaliser([
      {
        prospect_id: prospect.id,
        type: ConversionEventType.COUPON,
        label: `Coupon ${code} (${offre.label}) ${LIBELLE_CANAL[envoi.canal]}`,
        actor_id: user.id,
        campaign_id: campagneId,
        data: { coupon_id: coupon.id, canal: envoi.canal },
      },
    ]);
    this.events.signaler([prospect.id], 'coupon');
    return {
      coupon: { ...coupon, channel: envoi.canal, etat: 'ACTIF' as const },
      message: envoi.message,
      canal: envoi.canal,
      envoye: envoi.canal !== ConversionCouponChannel.AUCUN,
    };
  }

  /** Renvoie le message du coupon actif, sans créer de second code. */
  async renvoyer(user: User, prospectId: string) {
    const prospect = await this.chargerProspect(user, prospectId);
    const coupon = await this.prisma.conversionCoupon.findFirst({
      where: { prospect_id: prospect.id, used_at: null, expires_at: { gt: new Date() } },
      orderBy: { sent_at: 'desc' },
    });
    if (!coupon) throw new BadRequestException('Aucun coupon actif à renvoyer');

    const reglages = await this.config.lireReglages();
    const envoi = await this.expedier(prospect.customer, coupon, reglages);
    await this.prisma.conversionCoupon.update({
      where: { id: coupon.id },
      data: {
        resent_count: { increment: 1 },
        ...(envoi.canal !== ConversionCouponChannel.AUCUN && { channel: envoi.canal, message_sid: envoi.sid }),
        send_error: envoi.erreur,
      },
    });
    await this.events.journaliser([
      {
        prospect_id: prospect.id,
        type: ConversionEventType.COUPON_RENVOYE,
        label: `Coupon ${coupon.code} ${LIBELLE_CANAL[envoi.canal].replace('envoyé', 'renvoyé')}`,
        actor_id: user.id,
        campaign_id: coupon.campaign_id,
        data: { coupon_id: coupon.id, canal: envoi.canal },
      },
    ]);
    this.events.signaler([prospect.id], 'coupon');
    return { message: envoi.message, canal: envoi.canal, envoye: envoi.canal !== ConversionCouponChannel.AUCUN };
  }

  private async chargerProspect(user: User, prospectId: string) {
    const prospect = await this.prisma.conversionProspect.findFirst({
      where: { id: prospectId, entity_status: { not: EntityStatus.DELETED } },
      select: {
        id: true,
        status: true,
        assigned_to_id: true,
        campaign_id: true,
        campaign: { select: { status: true, offer_id: true } },
        customer: { select: { first_name: true, last_name: true, phone: true } },
      },
    });
    if (!prospect) throw new NotFoundException('Prospect introuvable');
    await this.access.assertPeutTraiter(user, prospect);
    if (prospect.status === ConversionProspectStatus.CONVERTI) {
      throw new BadRequestException('Ce client a déjà passé sa première commande');
    }
    return prospect;
  }

  private async expedier(
    client: { first_name: string | null; phone: string },
    coupon: { code: string; offer_label: string; expires_at: Date },
    reglages: { message_template: string; whatsapp_template_sid: string; app_link: string },
  ) {
    const variables = {
      prenom: prenomPourMessage(client.first_name),
      offre: coupon.offer_label,
      code: coupon.code,
      expiration: dateCourte(coupon.expires_at),
      lien: reglages.app_link,
    };
    const message = remplirModele(reglages.message_template, variables);
    let resultat: { channel: ConversionCouponChannel; sid: string | null };
    try {
      resultat = await this.twilio.sendConversionCoupon({
        phoneNumber: versE164(client.phone),
        templateSid: reglages.whatsapp_template_sid,
        // Ordre des variables du modèle WhatsApp : {{1}} prénom, {{2}} offre,
        // {{3}} code, {{4}} expiration, {{5}} lien.
        variables: {
          '1': variables.prenom,
          '2': variables.offre,
          '3': variables.code,
          '4': variables.expiration,
          '5': variables.lien,
        },
        smsBody: message,
      });
    } catch (e) {
      this.logger.warn(`Envoi du coupon ${coupon.code} impossible : ${(e as Error).message}`);
      resultat = { channel: ConversionCouponChannel.AUCUN, sid: null };
    }
    return {
      canal: resultat.channel,
      sid: resultat.sid,
      message,
      erreur:
        resultat.channel === ConversionCouponChannel.AUCUN
          ? "Ni WhatsApp ni SMS n'ont pu partir : dictez le code au client"
          : null,
    };
  }

  private async choisirOffre(candidates: (string | null | undefined)[]) {
    for (const id of candidates) {
      if (!id) continue;
      const offre = await this.prisma.conversionOffer.findFirst({
        where: { id, is_active: true, entity_status: { not: EntityStatus.DELETED } },
      });
      if (offre) return offre;
    }
    const premiere = await this.prisma.conversionOffer.findFirst({
      where: { is_active: true, entity_status: { not: EntityStatus.DELETED } },
      orderBy: { position: 'asc' },
    });
    if (!premiere) throw new BadRequestException('Aucune offre active : créez-en une dans les réglages');
    return premiere;
  }

  private async codeLibre(): Promise<string> {
    for (let i = 0; i < 8; i++) {
      const code = genererCodeCoupon();
      const pris = await this.prisma.promoCode.findUnique({ where: { code }, select: { id: true } });
      if (!pris) return code;
    }
    throw new BadRequestException('Impossible de générer un code unique, réessayez');
  }
}
