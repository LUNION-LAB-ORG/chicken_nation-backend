import { IsOptional, IsEnum, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { EntityStatus } from '@prisma/client';
import { Type } from 'class-transformer';

export class FilterQueryDto {
    @ApiPropertyOptional({ description: 'Numéro de page', default: 1 })
    @IsOptional()
    @Type(() => Number)
    page?: number = 1;

    @ApiPropertyOptional({ description: 'Nombre d\'items par page', default: 10 })
    @IsOptional()
    @Type(() => Number)
    limit?: number = 10;

    @ApiPropertyOptional({
        description: 'État de l\'entité',
        enum: EntityStatus,
        default: EntityStatus.ACTIVE
    })
    @IsEnum(EntityStatus)
    @IsOptional()
    status?: EntityStatus = EntityStatus.ACTIVE;

    @ApiPropertyOptional({ description: 'Termes de recherche (nom, email, téléphone,...)' })
    @IsString()
    @IsOptional()
    search?: string;

    @ApiPropertyOptional({ description: 'Tri par date de création', default: 'desc' })
    @IsString()
    @IsOptional()
    sort?: 'asc' | 'desc' = 'desc';

    @ApiPropertyOptional({ description: 'Tri par', default: 'created_at' })
    @IsString()
    @IsOptional()
    orderBy?: string = 'created_at';
}