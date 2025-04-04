import { IsEnum, IsOptional, IsUUID, IsDateString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { StatisticPeriod } from '../entities/sales-statistic.entity';

export class GetStatisticsDto {
  @ApiProperty({
    enum: StatisticPeriod,
    description: 'Period type for statistics',
    example: StatisticPeriod.MONTHLY,
  })
  @IsEnum(StatisticPeriod)
  periodType: StatisticPeriod;

  @ApiProperty({
    description: 'Start date for the statistics period',
    example: '2025-01-01',
  })
  @IsDateString()
  startDate: string;

  @ApiProperty({
    description: 'End date for the statistics period',
    example: '2025-01-31',
  })
  @IsDateString()
  endDate: string;

  @ApiProperty({
    description: 'Filter by restaurant ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
    required: false,
  })
  @IsOptional()
  @IsUUID()
  restaurantId?: string;

  @ApiProperty({
    description: 'Filter by category ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
    required: false,
  })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiProperty({
    description: 'Filter by product ID',
    example: '123e4567-e89b-12d3-a456-426614174000',
    required: false,
  })
  @IsOptional()
  @IsUUID()
  productId?: string;
}
