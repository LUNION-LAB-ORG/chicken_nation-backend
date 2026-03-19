import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsObject,
  IsEnum,
  IsBoolean,
  IsDateString,
} from 'class-validator';

export enum ScheduleType {
  ONCE = 'once',
  DAILY = 'daily',
  WEEKLY = 'weekly',
  MONTHLY = 'monthly',
  CUSTOM = 'custom',
}

export class CreateScheduledNotificationDto {
  @ApiProperty({ description: 'Nom de la notification planifiée' })
  @IsString()
  name: string;

  @ApiPropertyOptional({ enum: ['push', 'email', 'sms'], default: 'push' })
  @IsOptional()
  @IsString()
  channel?: string;

  @ApiProperty({ description: 'Payload OneSignal (headings, contents, etc.)' })
  @IsObject()
  payload: Record<string, unknown>;

  @ApiProperty({
    description: 'Config de ciblage { type: "segments"|"filters"|"aliases", segments?, filters?, aliases? }',
  })
  @IsObject()
  targeting: Record<string, unknown>;

  @ApiProperty({ enum: ScheduleType })
  @IsEnum(ScheduleType)
  schedule_type: ScheduleType;

  @ApiPropertyOptional({ description: 'Expression CRON (pour custom). Ex: "0 9 * * 1" = tous les lundis 9h' })
  @IsOptional()
  @IsString()
  cron_expression?: string;

  @ApiPropertyOptional({ description: 'Date/heure ISO pour envoi unique (schedule_type=once)' })
  @IsOptional()
  @IsDateString()
  scheduled_at?: string;

  @ApiPropertyOptional({ description: 'Timezone IANA. Défaut: Africa/Abidjan' })
  @IsOptional()
  @IsString()
  timezone?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
