import { IsEnum, IsUUID, IsOptional, IsNumber, Min, IsString } from 'class-validator';
import { Type } from 'class-transformer';
import { EntityStatus } from '@prisma/client';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class QueryDishDto {
    @ApiPropertyOptional({ description: "Rechercher un plat par son nom ou description" })
    @IsOptional()
    @IsString()
    search?: string;

    @ApiPropertyOptional({ description: "Filtrer par statut de plat", enum: EntityStatus })
    @IsOptional()
    @IsEnum(EntityStatus)
    status?: EntityStatus;

    @ApiPropertyOptional({ description: "Filtrer par ID de catégorie" })
    @IsOptional()
    @IsUUID()
    categoryId?: string;

    @ApiPropertyOptional({ description: "Montant minimum du plat" })
    @IsOptional()
    @IsNumber()
    @Min(0)
    @Type(() => Number)
    minPrice?: number;

    @ApiPropertyOptional({ description: "Montant maximum du plat" })
    @IsOptional()
    @IsNumber()
    @Min(0)
    @Type(() => Number)
    maxPrice?: number;

    @ApiPropertyOptional({ description: "Numéro de page", default: 1 })
    @IsOptional()
    @IsNumber()
    @Min(1)
    @Type(() => Number)
    page?: number;

    @ApiPropertyOptional({ description: "Nombre d'éléments par page", default: 10 })
    @IsOptional()
    @IsNumber()
    @Min(1)
    @Type(() => Number)
    limit?: number;

    @ApiPropertyOptional({ description: "Champ de tri", default: "created_at" })
    @IsOptional()
    @IsString()
    sortBy?: string;

    @ApiPropertyOptional({ description: "Ordre de tri (asc/desc)", default: "desc" })
    @IsOptional()
    @IsString()
    sortOrder?: 'asc' | 'desc';
}