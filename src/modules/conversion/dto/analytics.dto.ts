import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

/** Période commune aux tableaux de bord : jour, semaine, période libre, ou depuis le début. */
export class AnalyticsQueryDto {
  @IsOptional() @IsDateString()
  from?: string;

  @IsOptional() @IsDateString()
  to?: string;

  @IsOptional() @IsUUID()
  campaign_id?: string;
}

export class VerbatimsQueryDto extends AnalyticsQueryDto {
  @IsOptional() @IsUUID()
  loss_reason_id?: string;

  @IsOptional() @IsUUID()
  agent_id?: string;

  @IsOptional() @IsString() @MaxLength(100)
  search?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  limit?: number;
}
