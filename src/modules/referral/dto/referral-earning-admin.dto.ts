import { ApiPropertyOptional } from '@nestjs/swagger';
import { ReferralEarningStatus } from '@prisma/client';
import {
  ArrayNotEmpty,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

/** Passe des earnings PENDING→PAYABLE : par ids OU tout le PENDING d'un parrain. */
export class MarkPayableDto {
  @ApiPropertyOptional({ description: 'Ids des earnings à rendre versables', type: [String] })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  earning_ids?: string[];

  @ApiPropertyOptional({ description: 'Rendre versable tout le PENDING de ce parrain' })
  @IsOptional()
  @IsUUID('4')
  referrer_id?: string;
}

/** Marque des earnings PAYABLE→PAID (versement effectué hors-système). */
export class MarkPaidDto {
  @ApiPropertyOptional({ description: 'Ids des earnings versés', type: [String] })
  @IsArray()
  @ArrayNotEmpty()
  @IsUUID('4', { each: true })
  earning_ids!: string[];

  @ApiPropertyOptional({ description: 'Note de versement (référence, canal, etc.)' })
  @IsOptional()
  @IsString()
  note?: string;
}

/** Filtres de l'historique des earnings. */
export class EarningsHistoryQueryDto {
  @ApiPropertyOptional({ description: 'Filtrer par parrain' })
  @IsOptional()
  @IsUUID('4')
  referrer_id?: string;

  @ApiPropertyOptional({ enum: ReferralEarningStatus, description: 'Filtrer par statut' })
  @IsOptional()
  @IsEnum(ReferralEarningStatus)
  status?: ReferralEarningStatus;

  @ApiPropertyOptional({ description: 'Page (défaut 1)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ description: 'Taille de page (défaut 20, max 100)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}
