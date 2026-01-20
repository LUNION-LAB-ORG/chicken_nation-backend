import { IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateCategoryDto {
  @ApiProperty({ description: 'Nom de la catégorie' })
  @IsNotEmpty()
  @IsString()
  @Transform(({ value }) => value.trim())
  name: string;

  @ApiPropertyOptional({ description: 'Description de la catégorie' })
  @IsOptional()
  @IsString()
  @Transform(({ value }) => value.trim())
  description?: string;

  @ApiPropertyOptional({ description: 'Si la catégorie est privée' })
  @IsOptional()
  @Transform(({ value }) => (String(value).trim() == 'true'))
  @IsBoolean()
  private?: boolean;
}
