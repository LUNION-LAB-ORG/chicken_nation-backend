import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import { DeliveryOfferChannel, DeliveryOfferType } from '@prisma/client';

export class CreateDeliveryOfferDto {
  @ApiProperty({ description: 'Nom de l\'offre (interne)' })
  @IsString()
  @MaxLength(255)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ enum: DeliveryOfferType })
  @IsEnum(DeliveryOfferType)
  type: DeliveryOfferType;

  @ApiPropertyOptional({ description: '% (PERCENTAGE) ou FCFA (FIXED_AMOUNT) ; ignoré pour FREE_DELIVERY' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  value?: number;

  @ApiPropertyOptional({ description: 'Sous-total minimum requis (FCFA)' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  min_order_amount?: number;

  @ApiPropertyOptional({ enum: DeliveryOfferChannel })
  @IsOptional()
  @IsEnum(DeliveryOfferChannel)
  channel?: DeliveryOfferChannel;

  @ApiPropertyOptional({ type: [String], description: 'Restaurants ciblés (vide = tous)' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  restaurant_ids?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  target_standard?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  target_premium?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  target_gold?: boolean;

  @ApiPropertyOptional({ type: [String], description: 'Jours (minuscules en anglais), vide = tous' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  days_of_week?: string[];

  @ApiPropertyOptional({ description: 'Heure de début "HH:mm"' })
  @IsOptional()
  @Matches(/^\d{2}:\d{2}$/, { message: 'time_start doit être au format HH:mm' })
  time_start?: string;

  @ApiPropertyOptional({ description: 'Heure de fin "HH:mm"' })
  @IsOptional()
  @Matches(/^\d{2}:\d{2}$/, { message: 'time_end doit être au format HH:mm' })
  time_end?: string;

  @ApiProperty({ description: 'Date de début (ISO)' })
  @IsDateString()
  start_date: string;

  @ApiProperty({ description: "Date d'expiration (ISO)" })
  @IsDateString()
  expiration_date: string;

  @ApiPropertyOptional({ description: 'Usages max global (null = illimité)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  max_usage?: number;

  @ApiPropertyOptional({ description: 'Usages max par client (0 = illimité)' })
  @IsOptional()
  @IsInt()
  @Min(0)
  max_usage_per_user?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  is_active?: boolean;

  @ApiPropertyOptional({ description: 'Priorité (départage)' })
  @IsOptional()
  @IsInt()
  priority?: number;
}
