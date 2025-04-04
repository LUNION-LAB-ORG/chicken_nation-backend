import { IsNotEmpty, IsString, Matches } from 'class-validator';

export class OtpRequestDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^\+?[1-9]\d{1,14}$/, {
    message: 'Le numéro de téléphone doit être au format 10 chiffres (ex: +225 0101010101)',
  })
  phone_number: string;
}