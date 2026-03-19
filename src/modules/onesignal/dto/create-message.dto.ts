import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsObject,
  IsArray,
  IsBoolean,
  IsEnum,
  IsNumber,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export enum TargetChannel {
  PUSH = 'push',
  EMAIL = 'email',
  SMS = 'sms',
}

export class CreateMessageDto {
  // ── Canal ──
  @ApiPropertyOptional({ enum: TargetChannel })
  @IsOptional()
  @IsEnum(TargetChannel)
  target_channel?: TargetChannel;

  // ── Contenu Push ──
  @ApiPropertyOptional({ description: 'Corps du message localisé { "en": "Hello" }' })
  @IsOptional()
  @IsObject()
  contents?: Record<string, string>;

  @ApiPropertyOptional({ description: 'Titre localisé { "en": "Title" }' })
  @IsOptional()
  @IsObject()
  headings?: Record<string, string>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  url?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  app_url?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  big_picture?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  chrome_web_image?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  data?: Record<string, unknown>;

  // ── Contenu Email ──
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  email_subject?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  email_body?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  email_from_name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  email_from_address?: string;

  // ── Contenu SMS ──
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  sms_from?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  sms_media_urls?: string[];

  // ── Ciblage (un seul à la fois) ──
  @ApiPropertyOptional({ description: 'Segments cibles' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  included_segments?: string[];

  @ApiPropertyOptional({ description: 'Segments exclus' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  excluded_segments?: string[];

  @ApiPropertyOptional({ description: 'Aliases cibles { "external_id": ["id1", "id2"] }' })
  @IsOptional()
  @IsObject()
  include_aliases?: Record<string, string[]>;

  @ApiPropertyOptional({ description: 'Filtres de ciblage' })
  @IsOptional()
  @IsArray()
  filters?: Record<string, unknown>[];

  @ApiPropertyOptional({ description: 'IDs de souscription spécifiques' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  include_subscription_ids?: string[];

  // ── Planification ──
  @ApiPropertyOptional({ description: 'ISO 8601 UTC' })
  @IsOptional()
  @IsString()
  send_after?: string;

  @ApiPropertyOptional({ enum: ['timezone', 'last-active'] })
  @IsOptional()
  @IsString()
  delayed_option?: string;

  @ApiPropertyOptional({ description: 'Ex: "9:00AM"' })
  @IsOptional()
  @IsString()
  delivery_time_of_day?: string;

  // ── Template ──
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  template_id?: string;

  // ── Divers ──
  @ApiPropertyOptional({ description: 'Nom interne (max 128 chars)' })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  ttl?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  priority?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  content_available?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isIos?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isAndroid?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enable_frequency_cap?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  collapse_id?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  thread_id?: string;

  @ApiPropertyOptional({ description: 'Buttons push [{id, text, icon}]' })
  @IsOptional()
  @IsArray()
  buttons?: Record<string, string>[];
}
