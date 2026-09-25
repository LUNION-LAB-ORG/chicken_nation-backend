import { IsOptional, IsString, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * ⚠️ `limit` est plafonné à 100 sur toutes les listes de ce module. Sans
 * maximum, un seul appel en lecture (?limit=100000) renvoyait toute la table,
 * ce qui revenait à un export pour un rôle qui ne doit que consulter.
 */
export const PUSH_LIST_MAX_LIMIT = 100;

export class CampaignQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number;

  @ApiPropertyOptional({ default: 20, maximum: PUSH_LIST_MAX_LIMIT })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PUSH_LIST_MAX_LIMIT)
  @IsOptional()
  limit?: number;

  @ApiPropertyOptional({ enum: ['draft', 'sent', 'scheduled', 'failed'] })
  @IsString()
  @IsOptional()
  status?: string;

  @ApiPropertyOptional({ description: 'Recherche par nom' })
  @IsString()
  @IsOptional()
  search?: string;
}

export class TemplateQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number;

  @ApiPropertyOptional({ default: 20, maximum: PUSH_LIST_MAX_LIMIT })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PUSH_LIST_MAX_LIMIT)
  @IsOptional()
  limit?: number;

  @ApiPropertyOptional({ description: 'Recherche par nom' })
  @IsString()
  @IsOptional()
  search?: string;
}

/** Liste des abonnés push (GET /push-campaigns/users). */
export class PushUsersQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number;

  @ApiPropertyOptional({ default: 20, maximum: PUSH_LIST_MAX_LIMIT })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PUSH_LIST_MAX_LIMIT)
  @IsOptional()
  limit?: number;

  @ApiPropertyOptional({ description: 'Recherche par nom, prénom ou téléphone' })
  @IsString()
  @IsOptional()
  search?: string;
}
