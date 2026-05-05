import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDate, IsOptional, IsUUID } from 'class-validator';

export class GeneratePlanDto {
  @ApiProperty({
    description: 'UUID du restaurant pour lequel générer le plan',
    example: 'b84cea4a-4cbd-4da1-8a98-4c0f9fdf9a50',
  })
  @IsUUID()
  restaurantId!: string;

  @ApiProperty({
    description: 'Date de début de la période (ISO date)',
    example: '2026-04-28',
  })
  @Type(() => Date)
  @IsDate()
  periodStart!: Date;

  @ApiPropertyOptional({
    description:
      "Date de fin (incluse). Si absent, calculée comme periodStart + planning_period_weeks - 1 jour.",
    example: '2026-05-11',
  })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  periodEnd?: Date;
}
