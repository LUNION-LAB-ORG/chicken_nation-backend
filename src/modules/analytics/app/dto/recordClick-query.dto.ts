import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsDateString, IsInt, IsOptional, IsString, Min } from 'class-validator';

export enum ClickSortField {
    DATE = 'date',
    PLATFORM = 'platform',
    IP = 'ip',
}

export class RecordClickQueryDto {

    // --- 1. Pagination ---

    @ApiPropertyOptional({ description: 'Numéro de page', default: 1 })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    page?: number = 1;

    @ApiPropertyOptional({ description: 'Nombre d\'éléments par page', default: 25 })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    limit?: number = 25;

    // --- 2. Recherche Textuelle Globale ---

    @ApiPropertyOptional({ description: 'Termes de recherche (recherche sur platform, userAgent, ip)' })
    @IsString()
    @IsOptional()
    @Transform(({ value }) => String(value).trim())
    search?: string;

    // --- 3. Filtrage Spécifique ---

    @ApiPropertyOptional({ description: 'Filtre exact ou partiel sur la plateforme (ex: "mobile", "web")' })
    @IsOptional()
    @IsString()
    @Transform(({ value }) => String(value).trim())
    platform?: string;

    @ApiPropertyOptional({ description: "Filtre exact ou partiel sur l'adresse IP du client" })
    @IsOptional()
    @IsString()
    @Transform(({ value }) => String(value).trim())
    ip?: string;

    // --- 4. Filtrage Temporel (Plage de Dates) ---

    @ApiPropertyOptional({
        description: 'Date de début de la plage de recherche (format ISO 8601)',
        type: String,
        example: '2024-01-01T00:00:00Z'
    })
    @IsOptional()
    @IsDateString()
    dateFrom?: string;

    @ApiPropertyOptional({
        description: 'Date de fin de la plage de recherche (format ISO 8601)',
        type: String,
        example: '2024-12-31T23:59:59Z'
    })
    @IsOptional()
    @IsDateString()
    dateTo?: string;
}