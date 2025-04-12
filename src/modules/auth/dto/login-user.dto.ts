import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, MaxLength } from 'class-validator';

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
  @MaxLength(100)
  @Transform(({ value }) => value.trim())
  password: string;
}
