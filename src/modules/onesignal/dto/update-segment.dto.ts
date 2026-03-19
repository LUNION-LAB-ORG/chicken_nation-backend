import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsArray, MaxLength, ArrayMinSize, ArrayMaxSize } from 'class-validator';

export class UpdateSegmentDto {
  @ApiProperty({ description: 'Nom du segment (toujours requis pour update)' })
  @IsString()
  @MaxLength(128)
  name: string;

  @ApiPropertyOptional({ description: 'Filtres du segment (remplace tous les filtres existants)' })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  filters?: Record<string, unknown>[];
}
