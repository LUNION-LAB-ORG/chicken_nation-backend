import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsLatitude, IsLongitude, IsNumber, IsOptional, Max, Min } from 'class-validator';

/**
 * Vignette d'itinéraire pour l'aperçu du panier.
 *
 * Les bornes de taille ne sont pas cosmétiques : au-delà, Google refuse la
 * requête et l'image facturée est perdue.
 */
export class StaticRouteQueryDto {
  @ApiProperty() @Type(() => Number) @IsLatitude() originLat: number;
  @ApiProperty() @Type(() => Number) @IsLongitude() originLng: number;
  @ApiProperty() @Type(() => Number) @IsLatitude() destLat: number;
  @ApiProperty() @Type(() => Number) @IsLongitude() destLng: number;

  @ApiPropertyOptional({ default: 400 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(100) @Max(640)
  width?: number;

  @ApiPropertyOptional({ default: 200 })
  @IsOptional() @Type(() => Number) @IsInt() @Min(80) @Max(640)
  height?: number;

  @ApiPropertyOptional({
    default: 0,
    description: "Part haute de l'image à laisser libre, 0 à 0.4 (bandeau de l'écran)",
  })
  @IsOptional() @Type(() => Number) @IsNumber() @Min(0) @Max(0.4)
  topPad?: number;

  @ApiPropertyOptional({ default: 2, description: '1 ou 2 (écrans à haute densité)' })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(2)
  scale?: number;
}
