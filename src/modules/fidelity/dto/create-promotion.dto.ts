import { IsString, IsEnum, IsNumber, IsOptional, IsBoolean, IsArray, IsDateString, Min } from 'class-validator';
import { DiscountType, TargetType, PromotionStatus, Visibility } from '@prisma/client';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';

export class CreatePromotionDto {
  @ApiProperty({
    description: 'Titre de la promotion',
    example: 'Promotion d\'été',
  })
  @IsString()
  title: string;

  @ApiPropertyOptional({
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

  @ApiPropertyOptional({
    description: 'Montant minimum de commande',
    example: 10,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Transform(({ value }) => Number(value))
  min_order_amount?: number;

  @ApiPropertyOptional({
    description: 'Montant maximum de remise',
    example: 10,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Transform(({ value }) => Number(value))
  max_discount_amount?: number;

  @ApiPropertyOptional({
    description: 'Nombre maximum d\'utilisations par utilisateur',
    example: 1,
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Transform(({ value }) => Number(value))
  max_usage_per_user?: number = 1;

  @ApiPropertyOptional({
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

  @ApiPropertyOptional({
    description: 'Visibilité de la promotion',
    example: 'PUBLIC',
  })
  @IsOptional()
  @IsEnum(Visibility)
  visibility?: Visibility = Visibility.PUBLIC;

  @ApiPropertyOptional({
    description: 'Ciblage par niveau de fidélité (pour les promotions privées)',
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => Boolean(value))
  target_standard?: boolean = false;

  @ApiPropertyOptional({
    description: 'Ciblage par niveau de fidélité (pour les promotions privées)',
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => Boolean(value))
  target_premium?: boolean = false;

  @ApiPropertyOptional({
    description: 'Ciblage par niveau de fidélité (pour les promotions privées)',
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => Boolean(value))
  target_gold?: boolean = false;

  @ApiPropertyOptional({
    description: 'Personnalisation visuelle',
    example: false,
  })
  @IsOptional()
  @IsString()
  coupon_image_url?: string;

  @ApiPropertyOptional({
    description: 'Couleur de fond',
    example: '#FF0000',
  })
  @IsOptional()
  @IsString()
  background_color?: string;

  @ApiPropertyOptional({
    description: 'Couleur du texte',
    example: '#FF0000',
  })
  @IsOptional()
  @IsString()
  text_color?: string;

  @ApiPropertyOptional({
    description: 'Couleur de fin de promotion',
    example: '#FF0000',
  })
  @IsOptional()
  @IsString()
  expiration_color?: string;

  @ApiPropertyOptional({
    description: 'Plats/catégories ciblés',
    example: [],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true }) // Validate each item in the array is a string (UUID)
  @Transform(({ value }) => JSON.parse(value))
  targeted_dish_ids?: string[];

  @ApiPropertyOptional({
    description: 'Plats/catégories ciblés',
    example: [],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true }) // Validate each item in the array is a string (UUID)
  @Transform(({ value }) => JSON.parse(value))
  targeted_category_ids?: string[];

  @ApiPropertyOptional({
    description: 'Plats offerts (pour BUY_X_GET_Y)',
    example: [],
  })
  @IsOptional()
  @IsArray()
  @Transform(({ value }) => JSON.parse(value))
  offered_dishes?: { dish_id: string; quantity: number }[];

  @ApiPropertyOptional({
    description: 'Liste des IDs des restaurants concernés par la promotion',
    type: [String],
    example: ['uuid-restaurant-1', 'uuid-restaurant-2'],
  })
  @IsOptional()
  @IsArray()
  @Transform(({ value }) => JSON.parse(value))
  restaurant_ids?: string[];
}