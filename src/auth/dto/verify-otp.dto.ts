import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, MaxLength } from 'class-validator';

export class VerifyOtpDto {
  // PHONE
  @ApiProperty({
    description: "téléphone de l'utilisateur",
    example: '0777777777',
    required: true,
    maxLength: 20,
  })
  @IsNotEmpty()
  @MaxLength(20)
  @Transform(({ value }) => value.trim())
  phone: string;

  // OTP
  @ApiProperty({
    description: "code de vérification",
    example: '123456',
    required: true,
    maxLength: 4,
  })
  @IsNotEmpty()
  @MaxLength(4)
  @Transform(({ value }) => value.trim())
  otp: string;
}
