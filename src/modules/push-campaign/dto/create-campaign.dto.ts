import { IsString, IsOptional, IsObject, IsArray, IsEnum } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateCampaignDto {
  @ApiProperty({ description: 'Nom interne de la campagne' })
  @IsString()
  name: string;

  @ApiProperty({ description: 'Titre de la notification push' })
  @IsString()
  title: string;

  @ApiProperty({ description: 'Corps du message push' })
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

  @ApiProperty({
    description: 'Type de ciblage',
    enum: ['all', 'segment', 'filters', 'ids'],
  })
  @IsString()
  target_type: 'all' | 'segment' | 'filters' | 'ids';

  @ApiProperty({
    description: 'Configuration du ciblage (segment name, filters object, ou liste IDs)',
    example: { segment: 'active_buyers' },
  })
  @IsObject()
  target_config: Record<string, any>;

  @ApiPropertyOptional({ description: 'Date planifiée (si vide, envoi immédiat)' })
  @IsString()
  @IsOptional()
  scheduled_at?: string;
}

export class SegmentPreviewDto {
  @ApiProperty({ enum: ['all', 'segment', 'filters', 'ids'] })
  @IsString()
  target_type: 'all' | 'segment' | 'filters' | 'ids';

  @ApiProperty()
  @IsObject()
  target_config: Record<string, any>;
}
