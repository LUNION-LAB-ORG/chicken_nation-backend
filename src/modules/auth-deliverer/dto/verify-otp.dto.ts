import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, Length, MaxLength } from 'class-validator';

import { normaliserTelephoneSaisi } from './telephone.transform';

/**
 * Vérifie un OTP reçu par SMS / WhatsApp.
 * Utilisé pour l'inscription (→ verifyToken) et pour le reset (→ resetToken).
 */
export class VerifyDelivererOtpDto {
  /**
   * Même normalisation que RegisterPhoneDto, qui fixe la forme sous laquelle
   * le code est enregistré. Le code est cherché par égalité exacte : une autre
   * graphie du même numéro le retrouve donc, et le numéro porté par le jeton
   * de vérification (qui devient celui du compte) est toujours sous la forme
   * que la connexion recherche.
   */
  @ApiProperty({ description: 'Numéro de téléphone', example: '+2250777777777' })
  @IsNotEmpty()
  @MaxLength(20)
  @Transform(normaliserTelephoneSaisi)
  phone: string;

  @ApiProperty({ description: 'Code OTP à 4 chiffres', example: '1234' })
  @IsNotEmpty()
  @Length(4, 4)
  @Transform(({ value }) => String(value).trim())
  otp: string;
}
