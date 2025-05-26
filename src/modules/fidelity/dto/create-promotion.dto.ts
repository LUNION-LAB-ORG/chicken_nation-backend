import { IsString, IsEnum, IsNumber, IsOptional, IsBoolean, IsArray, IsDateString, Min } from 'class-validator';
import { DiscountType, TargetType, PromotionStatus, Visibility } from '@prisma/client';
import { ApiProperty } from '@nestjs/swagger';

export class CreatePromotionDto {
  @ApiProperty({
    description: 'Titre de la promotion',
    example: 'Promotion d\'été',
  })
  @IsString()
  title: string;

  @ApiProperty({
    description: 'Description de la promotion',
    example: 'Promotion d\'été',
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({
    description: 'Type de remise',
    example: 'PERCENTAGE',
  })
  @IsEnum(DiscountType)
  discount_type: DiscountType;

  @ApiProperty({
    description: 'Valeur de la remise',
    example: 10,
  })
  @IsNumber()
  @Min(0)
  discount_value: number;

  @ApiProperty({
    description: 'Type de ciblage',
    example: 'ALL_PRODUCTS',
  })
  @IsEnum(TargetType)
  target_type: TargetType;

  @ApiProperty({
    description: 'Montant minimum de commande',
    example: 10,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  min_order_amount?: number;

  @ApiProperty({
    description: 'Montant maximum de remise',
    example: 10,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  max_discount_amount?: number;

  @ApiProperty({
    description: 'Nombre maximum d\'utilisations par utilisateur',
    example: 1,
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  max_usage_per_user?: number = 1;

  @ApiProperty({
    description: 'Nombre maximum d\'utilisations globales',
    example: 1,
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  max_total_usage?: number;

  @ApiProperty({
    description: 'Date de début de la promotion',
    example: '2025-01-01',
  })
  @IsDateString()
  start_date: string;

  @ApiProperty({
    description: 'Date de fin de la promotion',
    example: '2025-01-01',
  })
  @IsDateString()
  expiration_date: string;

  @ApiProperty({
    description: 'Statut de la promotion',
    example: 'DRAFT',
  })
  @IsOptional()
  @IsEnum(PromotionStatus)
  status?: PromotionStatus = PromotionStatus.DRAFT;

  @ApiProperty({
    description: 'Visibilité de la promotion',
    example: 'PUBLIC',
  })
  @IsOptional()
  @IsEnum(Visibility)
  visibility?: Visibility = Visibility.PUBLIC;

  @ApiProperty({
    description: 'Ciblage par niveau de fidélité (pour les promotions privées)',
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  target_standard?: boolean = false;

  @ApiProperty({
    description: 'Ciblage par niveau de fidélité (pour les promotions privées)',
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  target_premium?: boolean = false;

  @ApiProperty({
    description: 'Ciblage par niveau de fidélité (pour les promotions privées)',
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  target_gold?: boolean = false;

  @ApiProperty({
    description: 'Personnalisation visuelle',
    example: false,
  })
  @IsOptional()
  @IsString()
  coupon_image_url?: string;

  @IsOptional()
  @IsString()
  background_color?: string;

  @IsOptional()
  @IsString()
  text_color?: string;

  @ApiProperty({
    description: 'Plats/catégories ciblés',
    example: [],
  })
  @IsOptional()
  @IsArray()
  targeted_dish_ids?: string[];

  @ApiProperty({
    description: 'Plats/catégories ciblés',
    example: [],
  })
  @IsOptional()
  @IsArray()
  targeted_category_ids?: string[];

  @ApiProperty({
    description: 'Plats offerts (pour BUY_X_GET_Y)',
    example: [],
  })
  @IsOptional()
  @IsArray()
  offered_dishes?: { dish_id: string; quantity: number }[];
}