import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsObject, IsBoolean, IsArray, MaxLength } from 'class-validator';

export class CreateOneSignalTemplateDto {
  @ApiProperty({ description: 'Nom du template (max 128 chars)' })
  @IsString()
  @MaxLength(128)
  name: string;

  // ── Push ──
  @ApiPropertyOptional({ description: 'Corps localisé { "en": "..." }' })
  @IsOptional()
  @IsObject()
  contents?: Record<string, string>;

  @ApiPropertyOptional({ description: 'Titre localisé { "en": "..." }' })
  @IsOptional()
  @IsObject()
  headings?: Record<string, string>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  subtitle?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  global_image?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  url?: string;

  // ── Email ──
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isEmail?: boolean;

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
  email_preheader?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  email_reply_to_address?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  disable_email_click_tracking?: boolean;

  // ── SMS ──
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isSMS?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  sms_from?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  sms_media_urls?: string[];

  // ── Platform toggles ──
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isAndroid?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isIos?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isChromeWeb?: boolean;
}
