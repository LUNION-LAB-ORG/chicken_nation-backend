import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, MaxLength } from 'class-validator';

/**
 * Étape 1 de l'inscription livreur : envoyer un numéro pour recevoir un OTP.
 * Le même DTO est utilisé pour le "mot de passe oublié".
 */
export class RegisterPhoneDto {
  @ApiProperty({
    description: 'Numéro de téléphone du livreur (format international)',
    example: '+2250777777777',
    required: true,
    maxLength: 20,
  })
  @IsNotEmpty()
  @MaxLength(20)
  @Transform(({ value }) => {
    let phoneNumber = value;
    if (!value.startsWith('+')) phoneNumber = `+${value}`;
    return phoneNumber.replace(/[^\d+]/g, '');
  })
  phone: string;
}
