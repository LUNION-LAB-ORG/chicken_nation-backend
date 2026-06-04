import { IsString, IsOptional, IsEmail } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';

/**
 * Modification d'un client par un agent BACKOFFICE (admin).
 * Limitée aux infos d'identité : prénom, nom, email, téléphone.
 * Tous les champs sont optionnels (PATCH partiel) : on ne met à jour
 * que ce qui est envoyé.
 */
export class AdminUpdateCustomerDto {
  @ApiPropertyOptional({ description: 'Numéro de téléphone', example: '+225070707070' })
  @IsString()
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  phone?: string;

  @ApiPropertyOptional({ description: 'Prénom du client', example: 'John' })
  @IsString()
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  first_name?: string;

  @ApiPropertyOptional({ description: 'Nom du client', example: 'Doe' })
  @IsString()
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  last_name?: string;

  @ApiPropertyOptional({ description: 'Email du client', example: 'john.doe@example.com' })
  @IsEmail({}, { message: 'Email non valide' })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  email?: string;
}
