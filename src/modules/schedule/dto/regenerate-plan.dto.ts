import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsOptional } from 'class-validator';

/**
 * Réédition des dates d'un plan (DRAFT/SENT) → régénère un nouveau plan DRAFT.
 */
export class RegeneratePlanDto {
  @ApiProperty({ example: '2026-06-08', description: 'Nouvelle date de début (YYYY-MM-DD)' })
  @IsDateString()
  periodStart: string;

  @ApiProperty({
    required: false,
    description: 'Date de fin (sinon calculée via planning_period_weeks)',
  })
  @IsOptional()
  @IsDateString()
  periodEnd?: string;
}
