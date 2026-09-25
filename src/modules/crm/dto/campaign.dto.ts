import { PartialType } from '@nestjs/swagger';
import { CampaignDistributionMode, CampaignStatus, CrmSegment } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { COMPTES_APPLI, type CompteAppli } from '../crm-campagne.rules';
import { SEGMENTS_CRM } from './contact.dto';

/**
 * Un public visé par une campagne et ses critères propres (lot 3). La période
 * porte sur l'inscription (inscrits), l'entrée en inactivité (inactifs) ou une
 * capture (Glovo/Yango). Restaurants et compte : Glovo/Yango seulement ;
 * « déjà reconquis » : inactifs seulement (vérifié par le service).
 */
export class CampaignPublicDto {
  @IsIn(SEGMENTS_CRM)
  segment: CrmSegment;

  @IsOptional() @IsDateString()
  period_from?: string | null;

  @IsOptional() @IsDateString()
  period_to?: string | null;

  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsUUID('all', { each: true })
  restaurant_ids?: string[];

  /** Compte sur l'application : AVEC, SANS, ou absent pour tous. */
  @IsOptional() @IsIn(COMPTES_APPLI)
  account?: CompteAppli | null;

  @IsOptional() @IsBoolean()
  relapsed_only?: boolean;

  /** Offre propre à ce public ; sinon celle de la campagne. */
  @IsOptional() @IsUUID()
  offer_id?: string | null;

  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(100)
  target_conversion_rate?: number | null;

  /** Contacts à joindre dans ce public. */
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  target_contacts_count?: number | null;
}

/** Paramètres d'une campagne (cahier §6.1). */
export class CreateCrmCampaignDto {
  @IsString() @Length(2, 255)
  name: string;

  @IsOptional() @IsString() @MaxLength(4000)
  description?: string;

  @IsDateString()
  start_date: string;

  @IsOptional() @IsDateString()
  end_date?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(365)
  duration_days?: number;

  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(100)
  target_conversion_rate?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  target_contacts_count?: number;

  @IsUUID()
  lead_agent_id: string;

  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(50) @IsUUID('all', { each: true })
  agent_ids: string[];

  @IsOptional() @IsUUID()
  offer_id?: string;

  @IsOptional() @IsEnum(CampaignDistributionMode)
  distribution_mode?: CampaignDistributionMode;

  /** Publics visés et leurs critères. Par défaut : les inscrits sans commande. */
  @IsOptional() @IsArray() @ArrayNotEmpty() @ArrayMaxSize(4)
  @ValidateNested({ each: true }) @Type(() => CampaignPublicDto)
  publics?: CampaignPublicDto[];

  /** Ancien corps, gardé le temps d'un déploiement : lu seulement sans `publics`. */
  @IsOptional() @IsDateString()
  registered_from?: string;

  /** Ancien corps, gardé le temps d'un déploiement : lu seulement sans `publics`. */
  @IsOptional() @IsDateString()
  registered_to?: string;

  /** Ancien corps, gardé le temps d'un déploiement : lu seulement sans `publics`. */
  @IsOptional() @IsArray() @ArrayNotEmpty() @IsIn(SEGMENTS_CRM, { each: true })
  segments?: CrmSegment[];
}

export class UpdateCrmCampaignDto extends PartialType(CreateCrmCampaignDto) {}

export class UpdateCrmTeamDto {
  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(50) @IsUUID('all', { each: true })
  agent_ids: string[];

  @IsOptional() @IsUUID()
  lead_agent_id?: string;
}

export class DistributeCrmDto {
  /** true : redistribue aussi les contacts déjà assignés mais jamais appelés. */
  @IsOptional() @IsBoolean()
  inclure_non_appeles?: boolean;
}

export class QueryCampaignsDto {
  @IsOptional() @IsIn(Object.values(CampaignStatus))
  status?: CampaignStatus;

  /** Campagnes qui visent ce public. */
  @IsOptional() @IsIn(SEGMENTS_CRM)
  segment?: CrmSegment;
}

/** Aperçu de la population avant le lancement : le formulaire en cours. */
export class PreviewCampaignDto {
  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(4)
  @ValidateNested({ each: true }) @Type(() => CampaignPublicDto)
  publics: CampaignPublicDto[];

  /** Équipe prévue : un contact suivi par l'un d'eux reste disponible. */
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsUUID('all', { each: true })
  agent_ids?: string[];
}

/** Comparatif des campagnes, restreint à celles qui visent un public. */
export class CompareCampaignsQueryDto {
  @IsOptional() @IsIn(SEGMENTS_CRM)
  segment?: CrmSegment;
}

export class CampaignReportQueryDto {
  @IsOptional() @IsIn(['xlsx', 'pdf'])
  format?: 'xlsx' | 'pdf';
}
