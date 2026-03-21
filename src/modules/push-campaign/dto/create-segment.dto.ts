import { IsString, IsOptional, IsObject } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class SegmentFiltersDto {
  @ApiPropertyOptional() @IsOptional() name_contains?: string;
  @ApiPropertyOptional() @IsOptional() phone_contains?: string;
  @ApiPropertyOptional() @IsOptional() email_contains?: string;
  @ApiPropertyOptional() @IsOptional() min_orders?: number;
  @ApiPropertyOptional() @IsOptional() max_orders?: number;
  @ApiPropertyOptional() @IsOptional() min_spent?: number;
  @ApiPropertyOptional() @IsOptional() max_spent?: number;
  @ApiPropertyOptional() @IsOptional() loyalty_level?: string;
  @ApiPropertyOptional() @IsOptional() city?: string;
  @ApiPropertyOptional() @IsOptional() min_points?: number;
  @ApiPropertyOptional() @IsOptional() max_points?: number;
  @ApiPropertyOptional() @IsOptional() registered_after?: string;
  @ApiPropertyOptional() @IsOptional() registered_before?: string;
  @ApiPropertyOptional() @IsOptional() last_order_days?: number;
  @ApiPropertyOptional() @IsOptional() no_order_days?: number;
}

export class CreateSegmentDto {
  @ApiProperty() @IsString() name: string;
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiProperty() @IsObject() filters: SegmentFiltersDto;
}

export class UpdateSegmentDto {
  @ApiPropertyOptional() @IsOptional() @IsString() name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional() @IsOptional() @IsObject() filters?: SegmentFiltersDto;
}
