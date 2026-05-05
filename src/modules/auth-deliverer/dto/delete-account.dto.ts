import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, Length, Matches } from 'class-validator';

/**
 * Confirmation par mot de passe avant suppression définitive du compte livreur.
 * Le code 4 chiffres garantit que le user a bien voulu cette action irréversible.
 */
export class DeleteAccountDto {
  @ApiProperty({ description: 'Code à 4 chiffres pour confirmer la suppression', example: '1234' })
  @IsNotEmpty()
  @Length(4, 4)
  @Matches(/^\d{4}$/, { message: 'Le mot de passe doit contenir exactement 4 chiffres' })
  password: string;
}
