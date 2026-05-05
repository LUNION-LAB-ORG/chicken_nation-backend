import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, Length, Matches } from 'class-validator';

/**
 * Étape finale du reset : reçoit le resetToken (issu de verify-reset-otp)
 * + le nouveau mot de passe 4 chiffres.
 */
export class ResetPasswordDto {
  @ApiProperty({ description: 'Token de reset (court, 15min)' })
  @IsNotEmpty()
  resetToken: string;

  @ApiProperty({ description: 'Nouveau code à 4 chiffres', example: '1234' })
  @IsNotEmpty()
  @Length(4, 4)
  @Matches(/^\d{4}$/, { message: 'Le mot de passe doit contenir exactement 4 chiffres' })
  password: string;
}
