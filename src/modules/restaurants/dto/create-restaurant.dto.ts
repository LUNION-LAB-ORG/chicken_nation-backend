import { IsString, IsOptional, IsBoolean, IsNumber, IsObject, Min, Max } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateRestaurantDto {
  @ApiProperty({ description: 'Nom du restaurant' })
  @IsString()
  name: string;

  @ApiProperty({ description: 'Description du restaurant', required: false })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({ description: 'Adresse du restaurant' })
  @IsString()
  address: string;

  @ApiProperty({ description: 'Localisation du restaurant (quartier, ville, etc.)' })
  @IsString()
  location: string;

  @ApiProperty({ description: 'Numéro de téléphone du restaurant' })
  @IsString()
  phone_number: string;

  @ApiProperty({ description: 'Email du restaurant', required: false })
  @IsString()
  @IsOptional()
  email?: string;

  @ApiProperty({ description: 'Indique si le restaurant est ouvert', default: true })
  @IsBoolean()
  @IsOptional()
  is_open?: boolean;

  @ApiProperty({ description: 'Heure de fermeture générale', required: false })
  @IsString()
  @IsOptional()
  closing_time?: string;

  @ApiProperty({ description: 'Heure d\'ouverture générale', required: false })
  @IsString()
  @IsOptional()
  opening_time?: string;

  @ApiProperty({ description: 'Heure de début des livraisons' })
  @IsString()
  delivery_start_time: string;

  @ApiProperty({ description: 'Heure de fin des livraisons', required: false })
  @IsString()
  @IsOptional()
  delivery_end_time?: string;

  @ApiProperty({ description: 'URL de l\'image du restaurant', required: false })
  @IsString()
  @IsOptional()
  image_url?: string;

  @ApiProperty({ description: 'Latitude de l\'emplacement du restaurant', required: false })
  @IsNumber()
  @IsOptional()
  latitude?: number;

  @ApiProperty({ description: 'Longitude de l\'emplacement du restaurant', required: false })
  @IsNumber()
  @IsOptional()
  longitude?: number;

  @ApiProperty({ description: 'Taille maximale de réservation autorisée' })
  @IsNumber()
  @Min(1)
  max_reservation_size: number;

  @ApiProperty({ description: 'Taille minimale de réservation autorisée' })
  @IsNumber()
  @Min(1)
  min_reservation_size: number;

  @ApiProperty({ description: 'Nombre d\'heures minimum avant une réservation' })
  @IsNumber()
  @Min(0)
  reservation_lead_hours: number;

  @ApiProperty({ description: 'Nombre maximum de jours à l\'avance pour une réservation' })
  @IsNumber()
  @Min(1)
  reservation_max_days: number;

  @ApiProperty({ description: 'Paramètres supplémentaires pour les réservations', required: false })
  @IsObject()
  @IsOptional()
  reservation_settings?: Record<string, any>;
}
