import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

export const ETATS_COUPON = ['AUCUN', 'ACTIF', 'UTILISE', 'EXPIRE'] as const;
export type EtatCoupon = (typeof ETATS_COUPON)[number];

export const TRIS_PROSPECTS = [
  'inscription_desc',
  'inscription_asc',
  'appel_desc',
  'appel_asc',
  'tentatives_desc',
] as const;

/** Filtres combinables de la liste (cahier §4.2), partagés avec l'export. */
export class QueryConversionProspectDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  limit?: number;

  @ApiPropertyOptional({ description: 'Nom, prénom, e-mail ou téléphone' })
  @IsOptional() @IsString() @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({ description: 'Statuts séparés par des virgules. Par défaut : tous sauf CONVERTI' })
  @IsOptional() @IsString()
  status?: string;

  @ApiPropertyOptional({ description: "Identifiant d'agent, ou « none » pour les non assignés" })
  @IsOptional() @IsString()
  agent_id?: string;

  @ApiPropertyOptional({ description: 'Identifiant de campagne, ou « none » pour hors campagne' })
  @IsOptional() @IsString()
  campaign_id?: string;

  @IsOptional() @IsUUID()
  call_status_id?: string;

  @IsOptional() @IsUUID()
  loss_reason_id?: string;

  @IsOptional() @IsIn(ETATS_COUPON)
  coupon?: EtatCoupon;

  @IsOptional() @IsDateString()
  registered_from?: string;

  @IsOptional() @IsDateString()
  registered_to?: string;

  @IsOptional() @IsDateString()
  last_call_from?: string;

  @IsOptional() @IsDateString()
  last_call_to?: string;

  @ApiPropertyOptional({ description: '« true » : jamais appelés' })
  @IsOptional() @IsIn(['true', 'false'])
  never_called?: string;

  @ApiPropertyOptional({ description: '« true » : au moins un paiement en ligne abandonné' })
  @IsOptional() @IsIn(['true', 'false'])
  abandoned?: string;

  @IsOptional() @IsIn(TRIS_PROSPECTS)
  sort?: (typeof TRIS_PROSPECTS)[number];
}

export class ExportConversionProspectDto extends QueryConversionProspectDto {
  @IsOptional() @IsIn(['csv', 'xlsx'])
  format?: 'csv' | 'xlsx';
}

export class AssignProspectsDto {
  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(2000) @IsUUID('all', { each: true })
  prospect_ids: string[];

  @ApiPropertyOptional({ description: 'null pour retirer l’agent' })
  @ValidateIf((_, v) => v !== null) @IsUUID()
  agent_id: string | null;
}

export class RecordCallDto {
  @IsUUID()
  call_status_id: string;

  @IsOptional() @IsUUID()
  loss_reason_id?: string;

  @IsOptional() @IsString() @MaxLength(2000)
  comment?: string;

  @IsOptional() @IsDateString()
  callback_at?: string;
}

export class SendCouponDto {
  @IsOptional() @IsUUID()
  offer_id?: string;
}

export class QueryExportsDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  limit?: number;
}
