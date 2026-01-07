import { IsOptional, IsEnum, IsString, IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { CardRequestStatus, NationCardStatus } from '@prisma/client';

export class CardRequestQueryDto {
    @ApiPropertyOptional({ description: 'Page actuelle', example: 1, minimum: 1 })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    page?: number = 1;

    @ApiPropertyOptional({ description: 'Nombre d\'éléments par page', example: 10, minimum: 1 })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    limit?: number = 10;

    @ApiPropertyOptional({ description: 'Recherche par nom, prénom, établissement ou numéro', example: 'Université' })
    @IsOptional()
    @IsString()
    search?: string;

    @ApiPropertyOptional({
        description: 'Filtrer par statut de demande',
        enum: CardRequestStatus
    })
    @IsOptional()
    @IsEnum(CardRequestStatus)
    status?: CardRequestStatus;

    @ApiPropertyOptional({ description: 'Filtrer par établissement', example: 'Université Félix' })
    @IsOptional()
    @IsString()
    institution?: string;
}

export class NationCardQueryDto {
    @ApiPropertyOptional({ description: 'Page actuelle', example: 1, minimum: 1 })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    page?: number = 1;

    @ApiPropertyOptional({ description: 'Nombre d\'éléments par page', example: 10, minimum: 1 })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    limit?: number = 10;

    @ApiPropertyOptional({ description: 'Recherche par nom, prénom ou numéro de carte', example: 'John' })
    @IsOptional()
    @IsString()
    search?: string;

    @ApiPropertyOptional({
        description: 'Filtrer par statut de carte',
        enum: NationCardStatus
    })
    @IsOptional()
    @IsEnum(NationCardStatus)
    status?: NationCardStatus;

    @ApiPropertyOptional({ description: 'Filtrer par établissement', example: 'Université Félix' })
    @IsOptional()
    @IsString()
    institution?: string;
}