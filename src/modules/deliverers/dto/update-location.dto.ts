import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumber, IsOptional, Max, Min } from 'class-validator';

/**
 * Payload GPS envoyé par l'app mobile livreur toutes les X secondes
 * (X = `deliverer.gps_update_interval_seconds` en settings, default 60).
 */
export class UpdateDelivererLocationDto {
  @ApiProperty({ description: 'Latitude WGS84', example: 5.3485 })
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat: number;

  @ApiProperty({ description: 'Longitude WGS84', example: -4.0267 })
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng: number;

  @ApiPropertyOptional({
    description:
      'Vitesse en mètres par seconde (fournie par expo-location / Core Location). ' +
      'Le backend convertit en km/h et rejette si supérieure à `deliverer.gps_max_speed_kmh`.',
    example: 8.33,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  speedMs?: number;

  @ApiPropertyOptional({
    description: 'Cap en degrés (0-360, 0 = Nord).',
    example: 120,
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(360)
  heading?: number;
}
