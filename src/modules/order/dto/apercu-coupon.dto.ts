import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { CreateOrderItemDto } from './create-order-item.dto';
import { OrderType } from '../enums/order-type.enum';
import { LONGUEUR_MAX_CODE } from '../helpers/coupon.helper';

/**
 * Corps de `POST /orders/coupon/apercu` : la commande telle qu'elle partira à
 * la création (mêmes lignes d'articles, même DTO). Aucun montant n'est reçu :
 * le serveur recalcule tout.
 */
export class ApercuCouponDto {
  @ApiProperty({ description: 'Code promo ou code de bon dicté par le client', maxLength: LONGUEUR_MAX_CODE })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsString({ message: 'Le code doit être un texte.' })
  @IsNotEmpty({ message: 'Saisissez un code promo ou un bon.' })
  @MaxLength(LONGUEUR_MAX_CODE, { message: `Le code compte ${LONGUEUR_MAX_CODE} caractères au plus.` })
  code: string;

  @ApiProperty({ description: 'Client de la commande' })
  @IsUUID(undefined, { message: "Choisissez d'abord le client." })
  customer_id: string;

  @ApiProperty({ description: 'Restaurant qui prépare la commande' })
  @IsUUID(undefined, { message: "Choisissez d'abord le restaurant." })
  restaurant_id: string;

  @ApiProperty({ enum: OrderType })
  @IsEnum(OrderType, { message: 'Type de commande inconnu.' })
  type: OrderType;

  @ApiProperty({ type: [CreateOrderItemDto] })
  @IsArray({ message: 'Ajoutez au moins un article.' })
  @ArrayMinSize(1, { message: 'Ajoutez au moins un article.' })
  @ValidateNested({ each: true })
  @Type(() => CreateOrderItemDto)
  items: CreateOrderItemDto[];

  /**
   * Commande en cours de MODIFICATION dont le coupon va être retiré : ses
   * usages ne comptent pas dans la limite par client, pour que le même code
   * puisse être réappliqué (articles changés, remise à refaire). Ignoré si la
   * commande n'est pas celle du client ou n'a pas de coupon.
   */
  @ApiPropertyOptional({ description: 'Commande en modification dont le coupon est retiré (remplacement)' })
  @IsOptional()
  @IsUUID(undefined, { message: 'Identifiant de commande invalide.' })
  commande_id?: string;
}
