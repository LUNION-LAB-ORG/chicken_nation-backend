import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';

export class ApplyPromoCodeOrderItemDto {
  @ApiProperty({ description: 'Identifiant du plat', example: '11111111-1111-1111-1111-111111111111' })
  @IsNotEmpty()
  @IsUUID()
  dish_id: string;

  @ApiProperty({ description: 'Quantité commandée', example: 2 })
  @IsNotEmpty()
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  quantity: number;

  @ApiProperty({ description: 'Prix unitaire (FCFA)', example: 3500 })
  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  price: number;
}

export class ApplyPromoCodeDto {
  @ApiProperty({ description: 'Code promotionnel', example: 'PROMO2026' })
  @IsNotEmpty()
  @IsString()
  code: string;

  @ApiProperty({ description: 'Montant total de la commande (FCFA)', example: 15000 })
  @IsNotEmpty()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  order_amount: number;

  // Requis dès lors que le code cible des plats ou catégories spécifiques.
  // Pour un code en ALL_PRODUCTS, on peut l'omettre — la remise s'applique
  // sur order_amount entier.
  @ApiPropertyOptional({
    description:
      "Items du panier — REQUIS si le code promo est ciblé (SPECIFIC_PRODUCTS / CATEGORIES). Si omis et code ciblé, l'application est refusée.",
    type: [ApplyPromoCodeOrderItemDto],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ApplyPromoCodeOrderItemDto)
  order_items?: ApplyPromoCodeOrderItemDto[];
}
