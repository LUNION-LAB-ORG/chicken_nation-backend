import { IsNumber, IsInt, IsBoolean, IsOptional, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';

export class UpdateLoyaltyConfigDto {
    @ApiPropertyOptional({
        description: 'Points par XOF dépensé',
        example: 0.002,
        minimum: 0
    })
    @IsOptional()
    @IsNumber()
    @Min(0)
    @Transform(({ value }) => Number(value))
    points_per_xof?: number;

    @ApiPropertyOptional({
        description: 'Nombre de jours avant expiration des points',
        example: 365,
        minimum: 1
    })
    @IsOptional()
    @IsInt()
    @Min(1)
    @Transform(({ value }) => value === null ? null : Number(value))
    points_expiration_days?: number | null;

    @ApiPropertyOptional({
        description: 'Points minimum requis pour utilisation',
        example: 100,
        minimum: 0
    })
    @IsOptional()
    @IsInt()
    @Min(0)
    @Transform(({ value }) => Number(value))
    minimum_redemption_points?: number;

    @ApiPropertyOptional({
        description: 'Valeur d\'un point en XOF',
        example: 20,
        minimum: 0
    })
    @IsOptional()
    @IsNumber()
    @Min(0)
    @Transform(({ value }) => Number(value))
    point_value_in_xof?: number;

    @ApiPropertyOptional({
        description: 'Seuil de points pour niveau Standard',
        example: 300,
        minimum: 0
    })
    @IsOptional()
    @IsInt()
    @Min(0)
    @Transform(({ value }) => Number(value))
    standard_threshold?: number;

    @ApiPropertyOptional({
        description: 'Seuil de points pour niveau Premium',
        example: 700,
        minimum: 0
    })
    @IsOptional()
    @IsInt()
    @Min(0)
    @Transform(({ value }) => Number(value))
    premium_threshold?: number;

    @ApiPropertyOptional({
        description: 'Seuil de points pour niveau Gold',
        example: 1000,
        minimum: 0
    })
    @IsOptional()
    @IsInt()
    @Min(0)
    @Transform(({ value }) => Number(value))
    gold_threshold?: number;

    @ApiPropertyOptional({
        description: 'Activer ou désactiver le système de fidélité',
        example: true
    })
    @IsOptional()
    @IsBoolean()
    @Transform(({ value }) => value === 'true' || value === true)
    is_active?: boolean;
}