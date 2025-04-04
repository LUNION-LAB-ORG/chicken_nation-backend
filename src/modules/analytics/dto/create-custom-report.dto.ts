import { IsArray, IsBoolean, IsEnum, IsNotEmpty, IsObject, IsOptional, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { ReportFormat, ReportType } from '../entities/custom-report.entity';

export class CreateCustomReportDto {
  @ApiProperty({
    description: 'Name of the custom report',
    example: 'Monthly Sales Report',
  })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({
    description: 'Description of the custom report',
    example: 'Report showing monthly sales data for all restaurants',
    required: false,
  })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({
    enum: ReportType,
    description: 'Type of report',
    example: ReportType.SALES,
  })
  @IsEnum(ReportType)
  reportType: ReportType;

  @ApiProperty({
    enum: ReportFormat,
    description: 'Format of the report output',
    example: ReportFormat.CSV,
  })
  @IsEnum(ReportFormat)
  format: ReportFormat;

  @ApiProperty({
    description: 'Filters to apply to the report data',
    example: { restaurantId: '123e4567-e89b-12d3-a456-426614174000', startDate: '2025-01-01', endDate: '2025-01-31' },
  })
  @IsObject()
  filters: Record<string, any>;

  @ApiProperty({
    description: 'Columns to include in the report',
    example: ['date', 'restaurantName', 'totalSales', 'orderCount'],
  })
  @IsArray()
  columns: string[];

  @ApiProperty({
    description: 'Whether the report should be scheduled for regular generation',
    example: false,
    required: false,
  })
  @IsBoolean()
  @IsOptional()
  isScheduled?: boolean;

  @ApiProperty({
    description: 'Frequency for scheduled reports (cron expression)',
    example: '0 0 1 * *', // Run at midnight on the first day of each month
    required: false,
  })
  @IsString()
  @IsOptional()
  scheduleFrequency?: string;
}
