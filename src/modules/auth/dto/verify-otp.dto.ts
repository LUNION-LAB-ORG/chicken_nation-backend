import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { Matches } from 'class-validator';
import { MESSAGE_CODE_INVALIDE, MESSAGE_NUMERO_INVALIDE } from '../helpers/envois-otp.helper';
import { FORME_TELEPHONE, sansEspacesAutour } from './login-customer.dto';

export class VerifyOtpDto {
  // PHONE
  // Forme seulement ici : le service ramène toutes les graphies d'un numéro à
  // une seule clé (verrou des essais et recherche du code).
  @ApiProperty({
    description: "téléphone de l'utilisateur",
    example: '+2250777777777',
    required: true,
    maxLength: 20,
  })
  @Matches(FORME_TELEPHONE, { message: MESSAGE_NUMERO_INVALIDE })
  @Transform(sansEspacesAutour)
  phone: string;

  // OTP
  // Exactement 4 chiffres (OtpService), en texte : un nombre ou un champ
  // absent est refusé en 400 sans être compté comme un essai.
  @ApiProperty({
    description: 'code de vérification à 4 chiffres',
    example: '1234',
    required: true,
    maxLength: 4,
  })
  @Matches(/^\d{4}$/, { message: MESSAGE_CODE_INVALIDE })
  @Transform(sansEspacesAutour)
  otp: string;
}
