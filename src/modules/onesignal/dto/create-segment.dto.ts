import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsArray, MaxLength, ArrayMinSize, ArrayMaxSize } from 'class-validator';

export class CreateOneSignalSegmentDto {
  @ApiProperty({ description: 'Nom du segment (max 128 chars)' })
  @IsString()
  @MaxLength(128)
  name: string;

  @ApiProperty({ description: 'Filtres du segment (1-200 entrées)' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  filters: Record<string, unknown>[];
}
