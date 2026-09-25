import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
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
} from 'class-validator';
import { SEGMENTS_CRM } from './contact.dto';

type CodePublic = (typeof SEGMENTS_CRM)[number];

/** « A,B » ou ?segments=A&segments=B : une liste de publics, sans espaces ni vides. */
const versListe = ({ value }: { value: unknown }) => {
  if (value === undefined || value === null || value === '') return undefined;
  const brut = Array.isArray(value) ? value : [value];
  return brut
    .flatMap((v) => String(v).split(','))
    .map((v) => v.trim())
    .filter(Boolean);
};

/** Période commune aux tableaux de bord : jour, semaine, période libre, ou depuis le début. */
export class AnalyticsQueryDto {
  @IsOptional() @IsDateString()
  from?: string;

  @IsOptional() @IsDateString()
  to?: string;

  @IsOptional() @IsUUID()
  campaign_id?: string;

  /** Un seul public (ancien paramètre, gardé pour la compatibilité). */
  @ApiPropertyOptional({ enum: SEGMENTS_CRM })
  @IsOptional() @IsIn(SEGMENTS_CRM)
  segment?: CodePublic;

  /** Plusieurs publics, séparés par des virgules. Fusionné avec `segment`. Sans valeur : tous. */
  @ApiPropertyOptional({ description: 'Publics séparés par des virgules (ex. GLOVO,YANGO)' })
  @IsOptional() @Transform(versListe) @IsArray() @ArrayMaxSize(4) @IsIn(SEGMENTS_CRM, { each: true })
  segments?: CodePublic[];
}

/** Onglet Ventes : mêmes filtres, plus le restaurant (commande directe ou lieu de capture). */
export class VentesQueryDto extends AnalyticsQueryDto {
  @IsOptional() @IsUUID()
  restaurant_id?: string;
}

export class VerbatimsQueryDto extends AnalyticsQueryDto {
  @IsOptional() @IsUUID()
  loss_reason_id?: string;

  @IsOptional() @IsUUID()
  agent_id?: string;

  @IsOptional() @IsString() @MaxLength(100)
  search?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  limit?: number;
}

/** Cohortes d'un public : sans public, celles des inscrits (tous les clients par mois d'inscription). */
export class CohortesQueryDto {
  @ApiPropertyOptional({ enum: SEGMENTS_CRM })
  @IsOptional() @IsIn(SEGMENTS_CRM)
  segment?: CodePublic;

  @IsOptional() @IsDateString()
  from?: string;

  @IsOptional() @IsDateString()
  to?: string;
}

export const VUES_EXPORT_ANALYSE = ['publics'] as const;

/** Export d'une vue du tableau de bord, avec les filtres de l'écran. */
export class ExportAnalyticsQueryDto extends AnalyticsQueryDto {
  @ApiPropertyOptional({ enum: VUES_EXPORT_ANALYSE })
  @IsIn(VUES_EXPORT_ANALYSE)
  vue!: (typeof VUES_EXPORT_ANALYSE)[number];

  @ApiPropertyOptional({ enum: ['xlsx'] })
  @IsOptional() @IsIn(['xlsx'])
  format?: 'xlsx';
}
