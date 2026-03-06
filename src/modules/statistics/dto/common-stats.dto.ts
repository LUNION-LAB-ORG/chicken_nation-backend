import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  ValidateIf,
} from 'class-validator';
import { Transform } from 'class-transformer';

/**
 * DTO de base partagé par tous les rapports statistiques.
 * Supporte les filtres de date (période prédéfinie ou plage personnalisée)
 * et le filtre par restaurant.
 */
export class BaseStatsQueryDto {
  @ApiPropertyOptional({
    description: 'Filtrer par restaurant',
    example: 'uuid-restaurant-id',
  })
  @IsUUID()
  @IsOptional()
  restaurantId?: string;

  @ApiPropertyOptional({
    description: 'Date de début (ISO format YYYY-MM-DD)',
    example: '2025-01-01',
  })
  @IsDateString()
  @IsOptional()
  @ValidateIf((o) => o.startDate || o.endDate)
  startDate?: string;

  @ApiPropertyOptional({
    description: 'Date de fin (ISO format YYYY-MM-DD)',
    example: '2025-01-31',
  })
  @IsDateString()
  @IsOptional()
  @ValidateIf((o) => o.startDate || o.endDate)
  endDate?: string;

  @ApiPropertyOptional({
    enum: ['today', 'week', 'month', 'last_month', 'year'],
    description: 'Période prédéfinie (ignorée si startDate et endDate sont fournis)',
    default: 'month',
  })
  @IsIn(['today', 'week', 'month', 'last_month', 'year'])
  @IsOptional()
  @Transform(({ value }) => value || 'month')
  period?: 'today' | 'week' | 'month' | 'last_month' | 'year';
}
