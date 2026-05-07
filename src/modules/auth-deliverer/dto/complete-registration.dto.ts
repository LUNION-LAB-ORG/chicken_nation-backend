import { ApiProperty } from '@nestjs/swagger';
import { Genre, VehiculeType } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  Length,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Étape finale de l'inscription livreur.
 * Reçoit le verifyToken + toutes les infos profil + documents + mot de passe 4 chiffres.
 * Crée le Deliverer en status = PENDING_VALIDATION.
 */
export class CompleteRegistrationDto {
  @ApiProperty({ description: 'Token de vérification OTP (court, 15min)' })
  @IsNotEmpty()
  verifyToken: string;

  @ApiProperty({ example: 'Jean' })
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(255)
  @Transform(({ value }) => String(value).trim())
  first_name: string;

  @ApiProperty({ example: 'Dupont' })
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(255)
  @Transform(({ value }) => String(value).trim())
  last_name: string;

  @ApiProperty({ example: 'jean.dupont@example.com' })
  @IsNotEmpty()
  @IsEmail()
  @MaxLength(255)
  @Transform(({ value }) => String(value).trim().toLowerCase())
  email: string;

  @ApiProperty({ enum: Genre, example: Genre.HOMME })
  @IsNotEmpty()
  @IsEnum(Genre)
  genre: Genre;

  @ApiProperty({ enum: VehiculeType, example: VehiculeType.MOTO })
  @IsNotEmpty()
  @IsEnum(VehiculeType)
  type_vehicule: VehiculeType;

  @ApiProperty({ description: 'URL S3 de la pièce d\'identité' })
  @IsNotEmpty()
  @IsOptional()
  piece_identite?: string;

  @ApiProperty({ description: 'URL S3 du permis de conduire' })
  @IsNotEmpty()
  @IsOptional()
  permis_conduire?: string;

  @ApiProperty({ description: 'Numéro du permis de conduire', required: false })
  @IsOptional()
  @MaxLength(100)
  @Transform(({ value }) => value ? String(value).trim().toUpperCase() : undefined)
  numero_permis?: string;

  @ApiProperty({ description: 'Numéro d\'immatriculation du véhicule', required: false })
  @IsOptional()
  @MaxLength(50)
  @Transform(({ value }) => value ? String(value).trim().toUpperCase() : undefined)
  numero_immatriculation?: string;

  @ApiProperty({ description: 'Code à 4 chiffres', example: '1234' })
  @IsNotEmpty()
  @Length(4, 4)
  @Matches(/^\d{4}$/, { message: 'Le mot de passe doit contenir exactement 4 chiffres' })
  password: string;
}
