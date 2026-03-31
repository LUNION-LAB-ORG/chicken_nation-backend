import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DiscountType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';

export class CreatePromoCodeDto {
  @ApiProperty({ description: 'Code promotionnel unique', example: 'PROMO2026' })
  @IsNotEmpty()
  @IsString()
  code: string;

  @ApiPropertyOptional({ description: 'Description du code promo' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ description: 'Type de réduction', enum: DiscountType })
  @IsNotEmpty()
  @IsEnum(DiscountType)
  discount_type: DiscountType;

  @ApiProperty({ description: 'Valeur de la réduction', example: 10 })
  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  discount_value: number;

  @ApiPropertyOptional({ description: 'Montant minimum de commande', example: 5000 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  min_order_amount?: number;

  @ApiPropertyOptional({ description: 'Montant maximum de réduction (plafond)', example: 2000 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  max_discount_amount?: number;

  @ApiPropertyOptional({ description: 'Nombre maximum d\'utilisations globales' })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  max_usage?: number;

  @ApiPropertyOptional({ description: 'Nombre maximum d\'utilisations par utilisateur', default: 1 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  max_usage_per_user?: number;

  @ApiProperty({ description: 'Date de début de validité', example: '2026-04-01T00:00:00.000Z' })
  @IsNotEmpty()
  @IsDateString()
  start_date: string;

  @ApiProperty({ description: 'Date d\'expiration', example: '2026-12-31T23:59:59.999Z' })
  @IsNotEmpty()
  @IsDateString()
  expiration_date: string;

  @ApiPropertyOptional({ description: 'Actif ou non', default: true })
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;

  @ApiPropertyOptional({ description: 'Liste des IDs de restaurants ciblés' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  restaurant_ids?: string[];
}
