import { PartialType } from '@nestjs/swagger';
import { CrmCallOutcome, DiscountType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Length,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

export class CreateCallStatusDto {
  @IsString() @Length(2, 120)
  label: string;

  @IsEnum(CrmCallOutcome)
  outcome: CrmCallOutcome;
}

export class UpdateCallStatusDto extends PartialType(CreateCallStatusDto) {
  @IsOptional() @IsBoolean()
  is_active?: boolean;
}

export class CreateLossReasonDto {
  @IsString() @Length(2, 255)
  name: string;

  @IsOptional() @IsString() @MaxLength(1000)
  description?: string;
}

export class UpdateLossReasonDto extends PartialType(CreateLossReasonDto) {
  @IsOptional() @IsBoolean()
  is_active?: boolean;
}

/** Le « acheter X, obtenir Y » ne se prête pas à un coupon de bienvenue. */
const REMISES = [DiscountType.PERCENTAGE, DiscountType.FIXED_AMOUNT] as const;

export class CreateOfferDto {
  @IsString() @Length(2, 120)
  label: string;

  @IsOptional() @IsString() @MaxLength(1000)
  description?: string;

  @IsIn(REMISES)
  discount_type: DiscountType;

  @Type(() => Number) @IsNumber() @Min(1)
  discount_value: number;

  @IsOptional() @Type(() => Number) @IsNumber() @Min(0)
  max_discount_amount?: number;

  @IsOptional() @Type(() => Number) @IsNumber() @Min(0)
  min_order_amount?: number;

  @Type(() => Number) @IsInt() @Min(1) @Max(90)
  validity_days: number;
}

export class UpdateOfferDto extends PartialType(CreateOfferDto) {
  @IsOptional() @IsBoolean()
  is_active?: boolean;
}

export class ReorderDto {
  @IsArray() @ArrayNotEmpty() @IsUUID('all', { each: true })
  ids: string[];
}

export class UpdateCrmSettingsDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(20)
  max_attempts?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(720)
  alert_delay_hours?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(7) @Max(365)
  inactive_days?: number;

  @IsOptional() @IsString() @Matches(/^(HX[0-9a-fA-F]{32})?$/, {
    message: 'Identifiant de modèle Twilio invalide (HX suivi de 32 caractères)',
  })
  whatsapp_template_sid?: string;

  @IsOptional() @IsString() @Length(20, 700)
  message_template?: string;

  @IsOptional() @IsUrl({ require_protocol: true })
  app_link?: string;

  @IsOptional() @ValidateIf((_, v) => v !== '') @IsUUID()
  default_offer_id?: string;
}
