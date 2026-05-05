import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsInt, IsNotEmpty, IsOptional, Max, MaxLength, Min } from 'class-validator';

/**
 * Notation du client par le livreur (post-livraison).
 *
 * Le livreur peut envoyer 1-5 étoiles + un message optionnel pour signaler
 * le comportement du client (ex: agressivité, lieu difficile, fraude). Utilisé
 * par les ops pour identifier les clients problématiques. La note s'applique
 * sur la `Delivery` (pas l'Order ni le Customer directement) — c'est le contexte
 * de cette livraison spécifique qui est noté.
 */
export class RateCustomerDto {
  @ApiProperty({ description: 'Note de 1 à 5 étoiles', minimum: 1, maximum: 5 })
  @IsNotEmpty()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5)
  rating: number;

  @ApiProperty({ required: false, description: 'Message libre (max 500)', maxLength: 500 })
  @IsOptional()
  @MaxLength(500)
  @Transform(({ value }) => value?.trim())
  note?: string;
}
