import { IsOptional, IsEnum, IsString, IsUUID } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { EntityStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';

export class CustomerQueryDto {
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
    @Transform(({ value }) => String(value).toUpperCase().trim() as EntityStatus)
    status?: EntityStatus = EntityStatus.ACTIVE;

    @ApiPropertyOptional({ description: 'Termes de recherche (nom, email, téléphone)' })
    @IsString()
    @IsOptional()
    @Transform(({ value }) => String(value).trim())
    search?: string;

    @ApiPropertyOptional({ description: "Filtrer par ID de restaurant" })
    @IsOptional()
    @IsUUID()
    restaurantId?: string;
}