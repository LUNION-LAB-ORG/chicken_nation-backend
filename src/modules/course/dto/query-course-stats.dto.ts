import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsUUID } from 'class-validator';

/**
 * Filtres des stats agrégées pour la page Courses backoffice.
 * Période par défaut : 30 derniers jours.
 */
export class QueryCourseStatsDto {
  @ApiPropertyOptional({ description: 'Restaurant à filtrer (UUID)' })
  @IsOptional()
  @IsUUID()
  restaurant_id?: string;

  @ApiPropertyOptional({ description: 'Début de la période (ISO)' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({ description: 'Fin de la période (ISO)' })
  @IsOptional()
  @IsDateString()
  endDate?: string;
}
