import { IsOptional, IsEnum, IsString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { EntityStatus } from '@prisma/client';
import { Transform } from 'class-transformer';

export class CustomerQueryDto {
    @ApiPropertyOptional({ description: 'Numéro de page', default: 1 })
    @IsOptional()
    @Transform(({ value }) => Number(value))
    page?: number = 1;

    @ApiPropertyOptional({ description: 'Nombre d\'items par page', default: 10 })
    @IsOptional()
    @Transform(({ value }) => Number(value))
    limit?: number = 10;

    @ApiPropertyOptional({
        description: 'État de l\'entité',
        enum: EntityStatus,
        default: EntityStatus.ACTIVE
    })
    @IsEnum(EntityStatus)
    @IsOptional()
    @Transform(({ value }) => value.toString().toUpperCase().trim() as EntityStatus)
    status?: EntityStatus = EntityStatus.ACTIVE;

    @ApiPropertyOptional({ description: 'Termes de recherche (nom, email, téléphone)' })
    @IsString()
    @IsOptional()
    @Transform(({ value }) => value.toString())
    search?: string;
}