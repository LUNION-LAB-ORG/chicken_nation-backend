import { IsString, IsOptional, IsObject } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateTemplateDto {
  @ApiProperty({ description: 'Nom du template' })
  @IsString()
  name: string;

  @ApiProperty({ description: 'Titre de la notification' })
  @IsString()
  title: string;

  @ApiProperty({ description: 'Corps du message' })
  @IsString()
  body: string;

  @ApiPropertyOptional({ description: 'Données JSON (deep-link, etc.)' })
  @IsObject()
  @IsOptional()
  data?: Record<string, any>;

  @ApiPropertyOptional({ description: "URL de l'image" })
  @IsString()
  @IsOptional()
  image_url?: string;
}

export class UpdateTemplateDto {
  @IsString()
  @IsOptional()
  name?: string;

  @IsString()
  @IsOptional()
  title?: string;

  @IsString()
  @IsOptional()
  body?: string;

  @IsObject()
  @IsOptional()
  data?: Record<string, any>;

  @IsString()
  @IsOptional()
  image_url?: string;
}
