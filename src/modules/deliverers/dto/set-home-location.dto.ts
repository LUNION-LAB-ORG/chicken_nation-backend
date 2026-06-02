import { ApiProperty } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Définit le LIEU D'HABITATION (domicile) du livreur — distinct du GPS temps réel
 * (`last_location`). Choisi par le livreur à l'inscription (écran emplacement) et
 * utilisé côté admin pour classer les restaurants par proximité.
 */
export class SetHomeLocationDto {
  @ApiProperty({ example: 5.36 })
  @IsNumber()
  lat: number;

  @ApiProperty({ example: -4.0083 })
  @IsNumber()
  lng: number;

  @ApiProperty({ description: 'Adresse lisible (optionnelle)', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;
}
