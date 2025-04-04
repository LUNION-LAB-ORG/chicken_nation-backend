import { IsString, IsBoolean, IsOptional, IsNumber, IsLatitude, IsLongitude } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateAddressDto {
  @ApiProperty({ description: 'Nom de l\'adresse (ex: Domicile, Travail)' })
  @IsString()
  name: string;

  @ApiProperty({ description: 'Adresse complète' })
  @IsString()
  address: string;

  @ApiProperty({ description: 'Détails supplémentaires (étage, code, etc.)', required: false })
  @IsString()
  @IsOptional()
  details?: string;

  @ApiProperty({ description: 'Latitude des coordonnées GPS', required: false, example: 48.8566 })
  @IsNumber()
  @IsLatitude()
  @IsOptional()
  latitude?: number;

  @ApiProperty({ description: 'Longitude des coordonnées GPS', required: false, example: 2.3522 })
  @IsNumber()
  @IsLongitude()
  @IsOptional()
  longitude?: number;

  @ApiProperty({ description: 'Définir comme adresse par défaut', default: false })
  @IsBoolean()
  @IsOptional()
  isDefault?: boolean;
}
