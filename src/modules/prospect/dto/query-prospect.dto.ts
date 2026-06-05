import { IsOptional, IsEnum, IsString, IsUUID, IsInt, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ProspectPlatform, ProspectStatus } from '@prisma/client';

/**
 * Filtres de la liste des contacts (admin). Cf. cahier §4.2.
 */
export class QueryProspectDto {
  @ApiPropertyOptional({ description: 'Filtrer par store (restaurant)' })
  @IsOptional()
  @IsUUID()
  restaurantId?: string;

  @ApiPropertyOptional({ enum: ProspectPlatform })
  @IsOptional()
  @IsEnum(ProspectPlatform)
  platform?: ProspectPlatform;

  @ApiPropertyOptional({ enum: ProspectStatus })
  @IsOptional()
  @IsEnum(ProspectStatus)
  status?: ProspectStatus;

  @ApiPropertyOptional({ description: 'Recherche nom / téléphone / n° commande' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ description: 'Date de début (ISO)' })
  @IsOptional()
  @IsString()
  startDate?: string;

  @ApiPropertyOptional({ description: 'Date de fin (ISO)' })
  @IsOptional()
  @IsString()
  endDate?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 20;
}
