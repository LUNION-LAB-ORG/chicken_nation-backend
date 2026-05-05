import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Length, Matches } from 'class-validator';

/**
 * Payload de validation d'une récupération au restaurant par la caissière.
 *
 * Le livreur dicte son code 3 chiffres (donné à la création de la Course),
 * la caissière le saisit dans le backoffice → on déclenche en cascade :
 *   Course AT_RESTAURANT/ACCEPTED → IN_DELIVERY
 *   Orders READY → PICKED_UP
 *   Timestamps à jour partout
 */
export class ValidatePickupDto {
  @ApiProperty({
    description: 'Code de retrait à 3 chiffres donné par le livreur',
    example: '421',
  })
  @IsNotEmpty()
  @IsString()
  @Length(3, 3, { message: 'Le code retrait doit comporter exactement 3 chiffres' })
  @Matches(/^\d{3}$/, { message: 'Le code retrait doit être composé de 3 chiffres' })
  pickup_code: string;
}
