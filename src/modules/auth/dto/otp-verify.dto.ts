import { IsNotEmpty, IsString, Length, Matches } from 'class-validator';

export class OtpVerifyDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^\+?[1-9]\d{1,14}$/, {
    message: 'Le numéro de téléphone doit être au format 10 chiffres (ex: +225 0101010101)',

  })
  phone_number: string;

  @IsString()
  @IsNotEmpty()
  @Length(6, 6, { message: 'Le code OTP doit contenir exactement 6 chiffres' })
  @Matches(/^\d{6}$/, { message: 'Le code OTP doit contenir uniquement des chiffres' })
  otp_code: string;
}