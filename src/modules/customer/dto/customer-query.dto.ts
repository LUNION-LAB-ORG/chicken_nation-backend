import { IsOptional, IsEnum, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { EntityStatus } from '@prisma/client';

export class CustomerQueryDto {
    @ApiPropertyOptional({ description: 'Numéro de page', default: 1 })
    @IsOptional()
    page?: number = 1;

    @ApiPropertyOptional({ description: 'Nombre d\'items par page', default: 10 })
    @IsOptional()
    limit?: number = 10;

    @ApiPropertyOptional({
        description: 'État de l\'entité',
        enum: EntityStatus,
        default: EntityStatus.ACTIVE
    })
    @IsEnum(EntityStatus)
    @IsOptional()
    status?: EntityStatus = EntityStatus.ACTIVE;

    @ApiPropertyOptional({ description: 'Termes de recherche (nom, email, téléphone)' })
    @IsString()
    @IsOptional()
    search?: string;
}