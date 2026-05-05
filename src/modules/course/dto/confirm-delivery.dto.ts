import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, Length, Matches } from 'class-validator';

/**
 * Validation d'une livraison par PIN client.
 * Le client fournit au livreur un code à 4 chiffres reçu par push/SMS.
 */
export class ConfirmDeliveryDto {
  @ApiProperty({ description: 'PIN 4 chiffres fourni par le client', example: '1234' })
  @IsNotEmpty()
  @Length(4, 4)
  @Matches(/^\d{4}$/, { message: 'Le PIN doit contenir exactement 4 chiffres' })
  pin: string;
}
