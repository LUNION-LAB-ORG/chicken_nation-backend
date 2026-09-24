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
} from 'class-validator';

/** Publics qu'une campagne peut viser aujourd'hui (Glovo/Yango : lot 2). */
export const PUBLICS_CAMPAGNE: CrmSegment[] = [CrmSegment.JAMAIS_COMMANDE, CrmSegment.INACTIF];

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

  @IsOptional() @IsDateString()
  registered_from?: string;

  @IsOptional() @IsDateString()
  registered_to?: string;

  /** Publics visés. Par défaut : les inscrits sans commande. */
  @IsOptional() @IsArray() @ArrayNotEmpty() @IsIn(PUBLICS_CAMPAGNE, { each: true })
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
}

export class CampaignReportQueryDto {
  @IsOptional() @IsIn(['xlsx', 'pdf'])
  format?: 'xlsx' | 'pdf';
}
