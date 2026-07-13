import { ApiProperty } from '@nestjs/swagger';
import { LoyaltyLevel, RewardType } from '@prisma/client';
import {
  IsArray,
  IsDateString,
  IsEnum,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * Création d'une campagne « Envoyer un cadeau ».
 * Le `payload` est validé/enrichi côté service selon le `type` :
 *   GIFT       → { label, image? }
 *   VOUCHER    → { amount }
 *   PROMO_CODE → { code }   (le service vérifie le PromoCode et snapshotte la remise)
 */
export class CreateRewardCampaignDto {
  @ApiProperty({ description: 'Libellé de la campagne', example: 'Cadeau de fin d\'année' })
  @IsString()
  @MaxLength(120)
  name: string;

  @ApiProperty({ enum: RewardType, description: 'Type de récompense (GIFT | VOUCHER | PROMO_CODE)' })
  @IsEnum(RewardType)
  type: RewardType;

  @ApiProperty({ description: 'Contenu selon le type', type: 'object', additionalProperties: true })
  @IsObject()
  payload: Record<string, any>;

  @ApiProperty({ description: 'Ciblage', enum: ['all', 'ids'] })
  @IsIn(['all', 'ids'])
  target_type: 'all' | 'ids';

  @ApiProperty({ description: 'Ids clients (si target_type = ids)', required: false, type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  ids?: string[];

  @ApiProperty({ enum: LoyaltyLevel, required: false, description: 'Filtre niveau fidélité (si target_type = all)' })
  @IsOptional()
  @IsEnum(LoyaltyLevel)
  loyalty_level?: LoyaltyLevel;

  @ApiProperty({ required: false, description: 'Date/heure d\'envoi programmé (ISO). Absent = immédiat.' })
  @IsOptional()
  @IsDateString()
  scheduled_at?: string;

  @ApiProperty({ required: false, description: 'Expiration appliquée à chaque récompense (ISO).' })
  @IsOptional()
  @IsDateString()
  expires_at?: string;
}
