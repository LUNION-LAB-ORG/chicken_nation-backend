import { ApiPropertyOptional } from '@nestjs/swagger';
import { RewardType } from '@prisma/client';
import { IsInt, IsObject, IsOptional, IsString, Min } from 'class-validator';

/**
 * Config du parrainage (back office). `parrain` reste souplement typé (validé côté
 * service) : { type: RewardType, payload, expires_in_days? }.
 */
export class SetReferralConfigDto {
  @ApiPropertyOptional({ description: 'Montant du bon de bienvenue du filleul (FCFA)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  welcome_amount?: number;

  @ApiPropertyOptional({ description: 'Récompense du parrain : { type, payload, expires_in_days? }' })
  @IsOptional()
  @IsObject()
  parrain?: { type: RewardType; payload: Record<string, any>; expires_in_days?: number };

  @ApiPropertyOptional({ description: 'Id User créateur des bons système (vide = 1er User)' })
  @IsOptional()
  @IsString()
  created_by?: string;
}
