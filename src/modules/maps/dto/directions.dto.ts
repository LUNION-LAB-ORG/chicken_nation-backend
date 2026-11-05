import { IsIn, IsNumber, IsOptional, IsArray, ValidateNested, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class LatLngDto {
  @IsNumber()
  @Min(-90)
  @Max(90)
  latitude: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  longitude: number;
}

export class DirectionsQueryDto {
  @IsNumber()
  @Min(-90)
  @Max(90)
  @Type(() => Number)
  originLat: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  @Type(() => Number)
  originLng: number;

  @IsNumber()
  @Min(-90)
  @Max(90)
  @Type(() => Number)
  destLat: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  @Type(() => Number)
  destLng: number;

  /**
   * Waypoints encodés en JSON : `[{"latitude":x,"longitude":y},...]`
   * (passé en query string sous forme de string JSON)
   */
  @IsOptional()
  waypoints?: string;

  /**
   * `1` : départ d'un point fixe (restaurant), sans livreur à suivre. Tracé sans
   * trafic, deux fois moins cher et le plus souvent déjà en cache. Ignoré avec
   * des waypoints.
   */
  @IsOptional()
  @IsIn(['1'])
  sans_trafic?: string;
}
