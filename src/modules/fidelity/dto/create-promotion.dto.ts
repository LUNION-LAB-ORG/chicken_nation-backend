import { IsString, IsEnum, IsNumber, IsOptional, IsBoolean, IsArray, IsDateString, Min } from 'class-validator';
import { DiscountType, TargetType, PromotionStatus, Visibility } from '@prisma/client';
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';

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
  @Transform(({ value }) => Number(value))
  discount_value: number;

  @ApiProperty({
    description: 'Type de ciblage',
    example: 'ALL_PRODUCTS',
    enum: TargetType,
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
  @Transform(({ value }) => Number(value))
  min_order_amount?: number;

  @ApiProperty({
    description: 'Montant maximum de remise',
    example: 10,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Transform(({ value }) => Number(value))
  max_discount_amount?: number;

  @ApiProperty({
    description: 'Nombre maximum d\'utilisations par utilisateur',
    example: 1,
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Transform(({ value }) => Number(value))
  max_usage_per_user?: number = 1;

  @ApiProperty({
    description: 'Nombre maximum d\'utilisations globales',
    example: 1,
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Transform(({ value }) => Number(value))
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
    enum: PromotionStatus,
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
  @Transform(({ value }) => Boolean(value))
  target_standard?: boolean = false;

  @ApiProperty({
    description: 'Ciblage par niveau de fidélité (pour les promotions privées)',
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => Boolean(value))
  target_premium?: boolean = false;

  @ApiProperty({
    description: 'Ciblage par niveau de fidélité (pour les promotions privées)',
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => Boolean(value))
  target_gold?: boolean = false;

  @ApiProperty({
    description: 'Personnalisation visuelle',
    example: false,
  })
  @IsOptional()
  @IsString()
  coupon_image_url?: string;

  @ApiProperty({
    description: 'Couleur de fond',
    example: '#FF0000',
  })
  @IsOptional()
  @IsString()
  background_color?: string;

  @ApiProperty({
    description: 'Couleur du texte',
    example: '#FF0000',
  })
  @IsOptional()
  @IsString()
  text_color?: string;

  @ApiProperty({
    description: 'Couleur de fin de promotion',
    example: '#FF0000',
  })
  @IsOptional()
  @IsString()
  expiration_color?: string;

  @ApiProperty({
    description: 'Plats/catégories ciblés',
    example: [],
  })
  @IsOptional()
  @IsArray()
  @Transform(({ value }) => JSON.parse(value))
  targeted_dish_ids?: string[];

  @ApiProperty({
    description: 'Plats/catégories ciblés',
    example: [],
  })
  @IsOptional()
  @IsArray()
  @Transform(({ value }) => JSON.parse(value))
  targeted_category_ids?: string[];

  @ApiProperty({
    description: 'Plats offerts (pour BUY_X_GET_Y)',
    example: [],
  })
  @IsOptional()
  @IsArray()
  @Transform(({ value }) => JSON.parse(value))
  offered_dishes?: { dish_id: string; quantity: number }[];
}