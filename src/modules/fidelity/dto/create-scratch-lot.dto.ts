import { ApiProperty } from '@nestjs/swagger';
import { LoyaltyLevel, RewardType } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Création d'un lot Gratte & Gagne (back office).
 * Le `payload` est validé/enrichi côté service selon le `reward_type` :
 *   POINTS     → { points }
 *   GIFT       → { dish_id, quantity? }  (le service vérifie le plat et snapshotte nom/prix/image)
 *   VOUCHER    → { amount }               (le service injecte `created_by` = admin)
 *   PROMO_CODE → { code }                 (le service vérifie le PromoCode et snapshotte la remise)
 */
export class CreateScratchLotDto {
  @ApiProperty({ description: 'Libellé du lot', example: 'Bon de 5 000 FCFA' })
  @IsString()
  @MaxLength(120)
  label: string;

  @ApiProperty({ enum: RewardType, description: 'Type de récompense du lot' })
  @IsEnum(RewardType)
  reward_type: RewardType;

  @ApiProperty({ description: 'Contenu-modèle selon le type', type: 'object', additionalProperties: true })
  @IsObject()
  payload: Record<string, any>;

  @ApiProperty({ description: 'Poids de tirage (proba relative, > 0)', example: 5, default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  weight?: number;

  @ApiProperty({ description: 'Coût réel FCFA du surcoût (enveloppe)', example: 5000, default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  unit_cost?: number;

  @ApiProperty({ description: 'Panier minimum (order.amount) — RG-09', example: 5000, default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  min_cart?: number;

  @ApiProperty({ description: 'Nb max par client sur la fenêtre (null = illimité)', required: false })
  @IsOptional()
  @IsInt()
  @Min(1)
  frequency_cap?: number | null;

  @ApiProperty({ description: 'Stock total (null = illimité)', required: false })
  @IsOptional()
  @IsInt()
  @Min(0)
  stock?: number | null;

  @ApiProperty({ enum: LoyaltyLevel, required: false, description: 'Niveau de fidélité minimum requis' })
  @IsOptional()
  @IsEnum(LoyaltyLevel)
  level_min?: LoyaltyLevel | null;

  @ApiProperty({ description: 'Lot plancher (révélation des points de base)', default: false })
  @IsOptional()
  @IsBoolean()
  is_floor?: boolean;

  @ApiProperty({ description: 'Lot actif', default: true })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
