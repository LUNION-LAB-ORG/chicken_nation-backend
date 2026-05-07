import { ApiProperty } from '@nestjs/swagger';
import { Genre } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEmail, IsEnum, IsOptional, MaxLength, MinLength } from 'class-validator';

/**
 * Mise à jour du profil livreur par lui-même.
 * N'expose PAS : phone, password, status, is_operational, restaurant_id, reference.
 */
export class UpdateProfileDto {
  @ApiProperty({ required: false, example: 'Jean' })
  @IsOptional()
  @MinLength(2)
  @MaxLength(255)
  @Transform(({ value }) => value?.trim())
  first_name?: string;

  @ApiProperty({ required: false, example: 'Dupont' })
  @IsOptional()
  @MinLength(2)
  @MaxLength(255)
  @Transform(({ value }) => value?.trim())
  last_name?: string;

  @ApiProperty({ required: false, example: 'jean.dupont@example.com' })
  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  @Transform(({ value }) => value?.trim().toLowerCase())
  email?: string;

  @ApiProperty({ required: false, enum: Genre })
  @IsOptional()
  @IsEnum(Genre)
  genre?: Genre;

  @ApiProperty({ required: false, description: 'Numéro du permis de conduire' })
  @IsOptional()
  @MaxLength(100)
  @Transform(({ value }) => (value ? String(value).trim().toUpperCase() : undefined))
  numero_permis?: string;

  @ApiProperty({ required: false, description: 'Numéro d\'immatriculation du véhicule' })
  @IsOptional()
  @MaxLength(50)
  @Transform(({ value }) => (value ? String(value).trim().toUpperCase() : undefined))
  numero_immatriculation?: string;
}
