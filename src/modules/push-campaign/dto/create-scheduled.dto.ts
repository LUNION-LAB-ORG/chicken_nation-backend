import { IsString, IsOptional, IsObject, IsBoolean } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateScheduledDto {
  @ApiProperty({ description: 'Nom de la notification planifiée' })
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

  @ApiProperty({
    description: 'Type de ciblage',
    enum: ['all', 'segment', 'filters', 'ids'],
  })
  @IsString()
  target_type: 'all' | 'segment' | 'filters' | 'ids';

  @ApiProperty({ description: 'Configuration du ciblage' })
  @IsObject()
  target_config: Record<string, any>;

  @ApiProperty({
    description: 'Type de planification',
    enum: ['once', 'daily', 'weekly', 'monthly', 'custom'],
  })
  @IsString()
  schedule_type: 'once' | 'daily' | 'weekly' | 'monthly' | 'custom';

  @ApiPropertyOptional({ description: 'Expression CRON (pour custom)' })
  @IsString()
  @IsOptional()
  cron_expression?: string;

  @ApiPropertyOptional({ description: "Date d'exécution (pour once)" })
  @IsString()
  @IsOptional()
  scheduled_at?: string;

  @ApiPropertyOptional({ default: 'Africa/Abidjan' })
  @IsString()
  @IsOptional()
  timezone?: string;
}

export class UpdateScheduledDto {
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

  @IsString()
  @IsOptional()
  target_type?: string;

  @IsObject()
  @IsOptional()
  target_config?: Record<string, any>;

  @IsString()
  @IsOptional()
  schedule_type?: string;

  @IsString()
  @IsOptional()
  cron_expression?: string;

  @IsString()
  @IsOptional()
  scheduled_at?: string;

  @IsString()
  @IsOptional()
  timezone?: string;
}
