import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityStatus } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { SettingsService } from 'src/modules/settings/settings.service';
import {
  CONVERSION_SETTINGS,
  DEFAULT_ALERT_DELAY_HOURS,
  DEFAULT_APP_LINK,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MESSAGE_TEMPLATE,
} from '../conversion.rules';
import {
  CreateCallStatusDto,
  CreateLossReasonDto,
  CreateOfferDto,
  UpdateCallStatusDto,
  UpdateConversionSettingsDto,
  UpdateLossReasonDto,
  UpdateOfferDto,
} from '../dto/config.dto';

export interface ReglagesConversion {
  max_attempts: number;
  alert_delay_hours: number;
  whatsapp_template_sid: string;
  message_template: string;
  app_link: string;
  default_offer_id: string;
}

const PAS_SUPPRIME = { entity_status: { not: EntityStatus.DELETED } };

/**
 * Listes déroulantes et réglages du module (cahier §9 : configurées par la
 * direction). Une valeur retirée est désactivée, jamais effacée : l'historique
 * des appels et des coupons y fait référence.
 */
@Injectable()
export class ConversionConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  // ---------------- Statuts d'appel ----------------

  listerStatutsAppel() {
    return this.prisma.conversionCallStatus.findMany({
      where: PAS_SUPPRIME,
      orderBy: { position: 'asc' },
    });
  }

  async creerStatutAppel(dto: CreateCallStatusDto) {
    const position = await this.prochainePosition('statut');
    return this.prisma.conversionCallStatus.create({ data: { ...dto, position } });
  }

  async modifierStatutAppel(id: string, dto: UpdateCallStatusDto) {
    await this.trouver('statut', id);
    return this.prisma.conversionCallStatus.update({ where: { id }, data: dto });
  }

  async supprimerStatutAppel(id: string) {
    await this.trouver('statut', id);
    return this.prisma.conversionCallStatus.update({
      where: { id },
      data: { entity_status: EntityStatus.DELETED, is_active: false },
    });
  }

  async reordonnerStatutsAppel(ids: string[]) {
    await this.prisma.$transaction(
      ids.map((id, position) =>
        this.prisma.conversionCallStatus.update({ where: { id }, data: { position } }),
      ),
    );
    return this.listerStatutsAppel();
  }

  // ---------------- Raisons de non-commande ----------------

  listerRaisons() {
    return this.prisma.prospectLossReason.findMany({
      where: PAS_SUPPRIME,
      orderBy: { position: 'asc' },
    });
  }

  async creerRaison(dto: CreateLossReasonDto) {
    const position = await this.prochainePosition('raison');
    return this.prisma.prospectLossReason.create({ data: { ...dto, position } });
  }

  async modifierRaison(id: string, dto: UpdateLossReasonDto) {
    await this.trouver('raison', id);
    return this.prisma.prospectLossReason.update({ where: { id }, data: dto });
  }

  async supprimerRaison(id: string) {
    await this.trouver('raison', id);
    return this.prisma.prospectLossReason.update({
      where: { id },
      data: { entity_status: EntityStatus.DELETED, is_active: false },
    });
  }

  async reordonnerRaisons(ids: string[]) {
    await this.prisma.$transaction(
      ids.map((id, position) =>
        this.prisma.prospectLossReason.update({ where: { id }, data: { position } }),
      ),
    );
    return this.listerRaisons();
  }

  // ---------------- Offres ----------------

  listerOffres() {
    return this.prisma.conversionOffer.findMany({
      where: PAS_SUPPRIME,
      orderBy: { position: 'asc' },
    });
  }

  async creerOffre(dto: CreateOfferDto) {
    this.verifierRemise(dto.discount_type, dto.discount_value);
    const position = await this.prochainePosition('offre');
    return this.prisma.conversionOffer.create({ data: { ...dto, position } });
  }

  async modifierOffre(id: string, dto: UpdateOfferDto) {
    const offre = await this.prisma.conversionOffer.findFirst({ where: { id, ...PAS_SUPPRIME } });
    if (!offre) throw new NotFoundException('Offre introuvable');
    this.verifierRemise(dto.discount_type ?? offre.discount_type, dto.discount_value ?? offre.discount_value);
    return this.prisma.conversionOffer.update({ where: { id }, data: dto });
  }

  async supprimerOffre(id: string) {
    await this.trouver('offre', id);
    return this.prisma.conversionOffer.update({
      where: { id },
      data: { entity_status: EntityStatus.DELETED, is_active: false },
    });
  }

  private verifierRemise(type: string, valeur: number) {
    if (type === 'PERCENTAGE' && valeur > 100) {
      throw new BadRequestException('Une remise en pourcentage ne peut pas dépasser 100 %');
    }
  }

  // ---------------- Réglages ----------------

  async lireReglages(): Promise<ReglagesConversion> {
    const v = await this.settings.getMany(Object.values(CONVERSION_SETTINGS));
    const entier = (valeur: string | undefined, defaut: number) =>
      Number(valeur) > 0 ? Math.floor(Number(valeur)) : defaut;
    return {
      max_attempts: entier(v[CONVERSION_SETTINGS.MAX_ATTEMPTS], DEFAULT_MAX_ATTEMPTS),
      alert_delay_hours: entier(v[CONVERSION_SETTINGS.ALERT_DELAY_HOURS], DEFAULT_ALERT_DELAY_HOURS),
      whatsapp_template_sid: v[CONVERSION_SETTINGS.WHATSAPP_TEMPLATE_SID] || '',
      message_template: v[CONVERSION_SETTINGS.MESSAGE_TEMPLATE] || DEFAULT_MESSAGE_TEMPLATE,
      app_link: v[CONVERSION_SETTINGS.APP_LINK] || DEFAULT_APP_LINK,
      default_offer_id: v[CONVERSION_SETTINGS.DEFAULT_OFFER_ID] || '',
    };
  }

  async modifierReglages(dto: UpdateConversionSettingsDto): Promise<ReglagesConversion> {
    if (dto.default_offer_id) await this.trouver('offre', dto.default_offer_id);
    const correspondances: [keyof UpdateConversionSettingsDto, string][] = [
      ['max_attempts', CONVERSION_SETTINGS.MAX_ATTEMPTS],
      ['alert_delay_hours', CONVERSION_SETTINGS.ALERT_DELAY_HOURS],
      ['whatsapp_template_sid', CONVERSION_SETTINGS.WHATSAPP_TEMPLATE_SID],
      ['message_template', CONVERSION_SETTINGS.MESSAGE_TEMPLATE],
      ['app_link', CONVERSION_SETTINGS.APP_LINK],
      ['default_offer_id', CONVERSION_SETTINGS.DEFAULT_OFFER_ID],
    ];
    for (const [champ, cle] of correspondances) {
      const valeur = dto[champ];
      if (valeur !== undefined) await this.settings.set(cle, String(valeur));
    }
    return this.lireReglages();
  }

  // ---------------- Outils ----------------

  private async prochainePosition(liste: 'statut' | 'raison' | 'offre'): Promise<number> {
    const agregat =
      liste === 'statut'
        ? await this.prisma.conversionCallStatus.aggregate({ _max: { position: true }, where: PAS_SUPPRIME })
        : liste === 'raison'
          ? await this.prisma.prospectLossReason.aggregate({ _max: { position: true }, where: PAS_SUPPRIME })
          : await this.prisma.conversionOffer.aggregate({ _max: { position: true }, where: PAS_SUPPRIME });
    return (agregat._max.position ?? 0) + 1;
  }

  private async trouver(liste: 'statut' | 'raison' | 'offre', id: string) {
    const trouve =
      liste === 'statut'
        ? await this.prisma.conversionCallStatus.findFirst({ where: { id, ...PAS_SUPPRIME }, select: { id: true } })
        : liste === 'raison'
          ? await this.prisma.prospectLossReason.findFirst({ where: { id, ...PAS_SUPPRIME }, select: { id: true } })
          : await this.prisma.conversionOffer.findFirst({ where: { id, ...PAS_SUPPRIME }, select: { id: true } });
    if (!trouve) {
      const libelle = { statut: "Statut d'appel", raison: 'Raison', offre: 'Offre' }[liste];
      throw new NotFoundException(`${libelle} introuvable`);
    }
    return trouve;
  }
}
