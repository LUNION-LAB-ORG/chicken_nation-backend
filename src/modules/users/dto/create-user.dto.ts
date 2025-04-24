import { ApiProperty } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsNotEmpty, MaxLength, IsOptional, IsString, IsPhoneNumber } from 'class-validator';

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
  @ApiProperty({ description: 'Numéro de téléphone de l\'utilisateur', example: '+225070707070' })
  @IsPhoneNumber("CI", { message: 'Numéro de téléphone non valide, utilisez le format +225' })
  @IsString()
  @Transform(({ value }) => value.trim())
  phone: string;

  // IMAGE
  @ApiProperty({
    description: "Image de l'utilisateur",
    required: false,
    type: "file" as "string",
  })
  @IsOptional()
  image?: string;

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
  @Transform(({ value }) => value.trim().toUpperCase() as UserRole)
  role: UserRole;
}
