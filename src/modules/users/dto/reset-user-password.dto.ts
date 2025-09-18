import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsString } from 'class-validator';

export class ResetUserPasswordResponseDto {
  @ApiProperty({
    description: "Email de l'utilisateur",
    example: 'Jean Dupont',
    required: true,
  })
  @IsEmail()
  @IsNotEmpty()
  email: string;

  @ApiProperty({
    description: "Mot de passe de l'utilisateur",
    example: 'Jean Dupont',
    required: true,
  })
  @IsString()
  @IsNotEmpty()
  password: string;
}
