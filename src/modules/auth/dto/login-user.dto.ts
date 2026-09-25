import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

export class LoginUserDto {
  // EMAIL
  @ApiProperty({
    description: "email de l'utilisateur",
    example: 'jean@gmail.com',
    required: true,
    maxLength: 100,
  })
  @IsNotEmpty()
  @IsString()
  @MaxLength(100)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
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
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @Matches(/^(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{}|;':\".,<>?/\\])[A-Za-z\d!@#$%^&*()_+\-=\[\]{}|;':\".,<>?/\\]{8,}$/, {
    message:
      'Le mot de passe doit contenir au moins 8 caractères, une majuscule, un chiffre et un caractère spécial.',
  })
  password: string;
}
