import { ApiProperty } from '@nestjs/swagger';
import { DeliveryFailureReason } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsNotEmpty, IsOptional, MaxLength } from 'class-validator';

/**
 * Échec de livraison signalé par le livreur (client absent, adresse introuvable, etc.).
 * Si `reason = OTHER`, `note` devient obligatoire.
 */
export class FailDeliveryDto {
  @ApiProperty({ enum: DeliveryFailureReason, description: 'Motif standard de l\'échec' })
  @IsNotEmpty()
  @IsEnum(DeliveryFailureReason)
  reason: DeliveryFailureReason;

  @ApiProperty({ required: false, description: 'Note libre (requis si reason=OTHER)' })
  @IsOptional()
  @MaxLength(500)
  @Transform(({ value }) => value?.trim())
  note?: string;
}
