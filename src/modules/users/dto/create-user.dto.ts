import { ApiProperty } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsNotEmpty, MaxLength, IsOptional } from 'class-validator';

export class CreateUserDto {
  // FULLNAME
  @ApiProperty({
    description: "Nom complet de l'utilisateur",
    example: 'Jean Dupont',
    required: true,
    maxLength: 100,
  })
  @IsNotEmpty()
  @MaxLength(100)
  @Transform(({ value }) => value.trim())
  fullname: string;

  // EMAIL
  @ApiProperty({
    description: "email de l'utilisateur",
    example: 'Jean',
    required: true,
    maxLength: 100,
  })
  @IsNotEmpty()
  @MaxLength(100)
  @Transform(({ value }) => value.trim())
  email: string;

  // PHONE
  @ApiProperty({
    description: "Téléphone de l'utilisateur",
    example: '771234567',
    required: false,
    maxLength: 20,
  })
  @IsOptional()
  @MaxLength(20)
  @Transform(({ value }) => value.trim())
  phone: string;

  // ADDRESS
  @ApiProperty({
    description: "Adresse de l'utilisateur",
    example: '123 rue du test',
    required: false,
    maxLength: 255,
  })
  @IsOptional()
  @MaxLength(255)
  @Transform(({ value }) => value.trim())
  address: string;

  // ROLE
  @ApiProperty({
    description: "le role de l'utilisateur",
    example: 'ADMIN',
    required: true,
    maxLength: 100,
  })
  @IsNotEmpty()
  @MaxLength(100)
  @Transform(({ value }) => value.trim())
  role: UserRole;
}
