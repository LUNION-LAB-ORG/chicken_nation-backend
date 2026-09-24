import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  CampaignStatus,
  CrmChannel,
  CrmEventType,
  CrmStatus,
  EntityStatus,
  TargetType,
  User,
} from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { TwilioService } from 'src/twilio/services/twilio.service';
import {
  dateCourte,
  genererCodeCoupon,
  identiteContact,
  joursRestants,
  prenomPourMessage,
  remplirModele,
  versE164,
} from '../crm.rules';
import { SendCouponDto } from '../dto/contact.dto';
import { CrmAccessService } from './crm-access.service';
import { CrmConfigService } from './crm-config.service';
import { CrmEventsService } from './crm-events.service';
import { nomClient } from './crm-contact.query';

const LIBELLE_CANAL: Record<CrmChannel, string> = {
  WHATSAPP: 'envoyé par WhatsApp',
  SMS: 'envoyé par SMS',
  AUCUN: "créé, mais aucun message n'est parti",
  INCONNU: 'envoyé (canal non noté)',
};

/** Renvoi d'un coupon existant : jamais « créé ». */
const LIBELLE_RENVOI: Record<CrmChannel, string> = {
  WHATSAPP: 'renvoyé par WhatsApp',
  SMS: 'renvoyé par SMS',
  AUCUN: "à renvoyer : aucun message n'est parti",
  INCONNU: 'renvoyé (canal non noté)',
};

/**
 * Coupons de bienvenue (cahier §5 et §8). Chaque coupon est un vrai code promo
 * à usage unique : c'est lui que la caisse et l'application acceptent, et
 * c'est par lui qu'une commande se rattache automatiquement au contact.
 */
@Injectable()
export class CrmCouponService {
  private readonly logger = new Logger(CrmCouponService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: CrmAccessService,
    private readonly config: CrmConfigService,
    private readonly events: CrmEventsService,
    private readonly twilio: TwilioService,
  ) {}

  async envoyer(user: User, contactId: string, dto: SendCouponDto) {
    const contact = await this.chargerContact(user, contactId);
    await this.access.assertPeutTraiter(user, contact);
    if (contact.status === CrmStatus.INJOIGNABLE) {
      throw new BadRequestException("Ce numéro est injoignable : aucun message ne pourrait partir");
    }
    const maintenant = new Date();
    const reglages = await this.config.lireReglages();
    const offre = await this.choisirOffre([dto.offer_id, contact.campaign?.offer_id, reglages.default_offer_id]);
    const code = await this.codeLibre();
    const expiration = new Date(maintenant.getTime() + offre.validity_days * 86_400_000);
    const campagneId =
      contact.campaign_id && contact.campaign?.status !== CampaignStatus.COMPLETED ? contact.campaign_id : null;

    const coupon = await this.prisma.$transaction(async (tx) => {
      await this.access.prendre(tx, user, contact.id, maintenant);
      // Contact verrouillé le temps de l'envoi : deux clics, ou deux agents,
      // ne créent jamais deux codes pour la même personne.
      await tx.$queryRaw`SELECT id FROM "CrmContact" WHERE id = ${contact.id}::uuid FOR UPDATE`;
      const actif = await tx.crmCoupon.findFirst({
        where: { contact_id: contact.id, used_at: null, expires_at: { gt: maintenant } },
        select: { code: true, expires_at: true },
      });
      if (actif) {
        throw new BadRequestException(
          `Un coupon est déjà actif (${actif.code}, jusqu'au ${dateCourte(actif.expires_at)}). Renvoyez-le plutôt que d'en créer un second.`,
        );
      }
      const claim = await tx.crmContact.updateMany({
        where: { id: contact.id, status: { not: CrmStatus.CONVERTI }, ...this.access.conditionAgent(user) },
        data: { status: CrmStatus.COUPON_ENVOYE, coupon_sent_at: maintenant, callback_at: null },
      });
      if (claim.count === 0) throw new BadRequestException('Ce client vient de commander : il est sorti de la liste');
      const promo = await tx.promoCode.create({
        data: {
          code,
          description: `Contact ${nomClient(contact)} : ${offre.label}`,
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
      return tx.crmCoupon.create({
        data: {
          contact_id: contact.id,
          segment: contact.segment,
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
    const envoi = await this.expedier(contact, coupon, reglages);
    await this.prisma.crmCoupon.update({
      where: { id: coupon.id },
      data: { channel: envoi.canal, message_sid: envoi.sid, send_error: envoi.erreur },
    });
    await this.events.journaliser([
      {
        contact_id: contact.id,
        type: CrmEventType.COUPON,
        label: `Coupon ${code} (${offre.label}) ${LIBELLE_CANAL[envoi.canal]}`,
        actor_id: user.id,
        campaign_id: campagneId,
        data: { coupon_id: coupon.id, canal: envoi.canal },
      },
    ]);
    this.events.signaler([contact.id], 'coupon');
    return {
      coupon: { ...coupon, channel: envoi.canal, etat: 'ACTIF' as const },
      message: envoi.message,
      canal: envoi.canal,
      envoye: envoi.canal !== CrmChannel.AUCUN,
    };
  }

  /**
   * Renvoie le message du coupon actif, sans créer de second code. Un agent de
   * la file commune prend le contact ; pour un client qui appelle (« je n'ai
   * pas reçu mon code »), tout agent peut renvoyer : le renvoi est tracé et
   * le contact reste à son agent.
   */
  async renvoyer(user: User, contactId: string, options: { codeAttendu?: string } = {}) {
    const contact = await this.chargerContact(user, contactId);
    this.access.assertAgent(user);
    const maintenant = new Date();
    const coupon = await this.prisma.$transaction(async (tx) => {
      if (this.access.dansFileCommune(contact, maintenant)) await this.access.prendre(tx, user, contact.id, maintenant);
      return tx.crmCoupon.findFirst({
        where: { contact_id: contact.id, used_at: null, expires_at: { gt: maintenant } },
        orderBy: { sent_at: 'desc' },
      });
    });
    if (!coupon) throw new BadRequestException('Aucun coupon actif à renvoyer');
    if (options.codeAttendu && coupon.code.toUpperCase() !== options.codeAttendu.toUpperCase()) {
      throw new ConflictException(`Un autre coupon est actif pour ce client (${coupon.code})`);
    }

    const reglages = await this.config.lireReglages();
    const envoi = await this.expedier(contact, coupon, reglages);
    await this.prisma.crmCoupon.update({
      where: { id: coupon.id },
      data: {
        resent_count: { increment: 1 },
        ...(envoi.canal !== CrmChannel.AUCUN && { channel: envoi.canal, message_sid: envoi.sid }),
        send_error: envoi.erreur,
      },
    });
    const pourUnAutre = !this.access.estGestionnaire(user) && contact.assigned_to_id && contact.assigned_to_id !== user.id;
    await this.events.journaliser([
      {
        contact_id: contact.id,
        type: CrmEventType.COUPON_RENVOYE,
        label: `Coupon ${coupon.code} ${LIBELLE_RENVOI[envoi.canal]}${pourUnAutre ? ' (demande du client)' : ''}`,
        actor_id: user.id,
        campaign_id: coupon.campaign_id,
        data: { coupon_id: coupon.id, canal: envoi.canal },
      },
    ]);
    this.events.signaler([contact.id], 'coupon');
    return { message: envoi.message, canal: envoi.canal, envoye: envoi.canal !== CrmChannel.AUCUN, code: coupon.code };
  }

  private async chargerContact(user: User, contactId: string) {
    const contact = await this.prisma.crmContact.findFirst({
      where: { id: contactId, entity_status: { not: EntityStatus.DELETED } },
      select: {
        id: true,
        status: true,
        segment: true,
        segment_since: true,
        assigned_to_id: true,
        campaign_id: true,
        campaign: { select: { status: true, offer_id: true } },
        name: true,
        phone: true,
        customer: { select: { first_name: true, last_name: true, phone: true } },
      },
    });
    if (!contact) throw new NotFoundException('Contact introuvable');
    if (contact.status === CrmStatus.CONVERTI) {
      throw new BadRequestException('Ce client a déjà commandé : il est sorti de la liste');
    }
    return contact;
  }

  private async expedier(
    contact: Parameters<typeof identiteContact>[0],
    coupon: { code: string; offer_label: string; expires_at: Date },
    reglages: { message_template: string; whatsapp_template_sid: string; app_link: string },
  ) {
    const identite = identiteContact(contact);
    const variables = {
      prenom: prenomPourMessage(identite.prenom),
      offre: coupon.offer_label,
      code: coupon.code,
      expiration: dateCourte(coupon.expires_at),
      lien: reglages.app_link,
    };
    const message = remplirModele(reglages.message_template, variables);
    let resultat: { channel: CrmChannel; sid: string | null };
    try {
      resultat = await this.twilio.sendCrmCoupon({
        phoneNumber: versE164(identite.telephone),
        templateSid: reglages.whatsapp_template_sid,
        // Variables du modèle approuvé : {{1}} prénom, {{2}} code, {{3}}
        // validité en jours. L'offre et le lien sont dans le texte du SMS.
        variables: {
          '1': variables.prenom,
          '2': variables.code,
          '3': String(joursRestants(coupon.expires_at)),
        },
        smsBody: message,
      });
    } catch (e) {
      this.logger.warn(`Envoi du coupon ${coupon.code} impossible : ${(e as Error).message}`);
      resultat = { channel: CrmChannel.AUCUN, sid: null };
    }
    return {
      canal: resultat.channel,
      sid: resultat.sid,
      message,
      erreur:
        resultat.channel === CrmChannel.AUCUN
          ? "Ni WhatsApp ni SMS n'ont pu partir : dictez le code au client"
          : null,
    };
  }

  private async choisirOffre(candidates: (string | null | undefined)[]) {
    for (const id of candidates) {
      if (!id) continue;
      const offre = await this.prisma.crmOffer.findFirst({
        where: { id, is_active: true, entity_status: { not: EntityStatus.DELETED } },
      });
      if (offre) return offre;
    }
    const premiere = await this.prisma.crmOffer.findFirst({
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
