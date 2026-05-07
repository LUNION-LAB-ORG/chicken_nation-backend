import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, Length, MaxLength } from 'class-validator';

/**
 * Vérifie un OTP reçu par SMS / WhatsApp.
 * Utilisé pour l'inscription (→ verifyToken) et pour le reset (→ resetToken).
 */
export class VerifyDelivererOtpDto {
  @ApiProperty({ description: 'Numéro de téléphone', example: '+2250777777777' })
  @IsNotEmpty()
  @MaxLength(20)
  @Transform(({ value }) => value.trim())
  phone: string;

  @ApiProperty({ description: 'Code OTP à 4 chiffres', example: '1234' })
  @IsNotEmpty()
  @Length(4, 4)
  @Transform(({ value }) => String(value).trim())
  otp: string;
}
