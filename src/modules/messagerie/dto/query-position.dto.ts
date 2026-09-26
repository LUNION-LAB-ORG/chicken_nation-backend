import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Taille de page utilisée par l'écran qui cherche un message. Elle DOIT être
 * celle de sa liste, sinon la page renvoyée ne correspond à rien.
 */
export class QueryPositionDto {
  @ApiPropertyOptional({ default: 100, minimum: 1, maximum: 500 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'La taille de page doit être un entier' })
  @Min(1, { message: 'La taille de page doit valoir au moins 1' })
  @Max(500, { message: 'La taille de page ne peut pas dépasser 500' })
  limit?: number = 100;
}
