import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, Matches, MaxLength } from 'class-validator';

export class LoginUserDto {
  // EMAIL
  @ApiProperty({
    description: "email de l'utilisateur",
    example: 'jean@gmail.com',
    required: true,
    maxLength: 100,
  })
  @IsNotEmpty()
  @MaxLength(100)
  @Transform(({ value }) => value.trim())
  email: string;

  // PASSWORD
  @ApiProperty({
    description: "mot de passe de l'utilisateur",
    example: 'Password01@',
    required: true,
    maxLength: 100,
  })

  @IsNotEmpty()
  @MaxLength(15)
  @Transform(({ value }) => value?.trim())
  @Matches(/^(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{}|;':\".,<>?/\\])[A-Za-z\d!@#$%^&*()_+\-=\[\]{}|;':\".,<>?/\\]{8,}$/, {
    message:
      'Le mot de passe doit contenir au moins 8 caractères, une majuscule, un chiffre et un caractère spécial.',
  })
  password: string;
}
