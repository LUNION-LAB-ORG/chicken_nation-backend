import {
    IsString,
    IsEnum,
    IsNumber,
    IsOptional,
    IsBoolean,
    IsArray,
    IsDateString,
    Min,
} from 'class-validator';
import { DiscountType, TargetType, PromotionStatus, Visibility } from '@prisma/client';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';

export class QueryPromotionDto {
    @ApiPropertyOptional({ description: 'Filtrer par titre' })
    @IsOptional()
    @IsString()
    title?: string;

    @ApiPropertyOptional({ description: 'Filtrer par type de remise' })
    @IsOptional()
    @IsEnum(DiscountType)
    discount_type?: DiscountType;

    @ApiPropertyOptional({ description: 'Filtrer par type de ciblage' })
    @IsOptional()
    @IsEnum(TargetType)
    target_type?: TargetType;

    @ApiPropertyOptional({ description: 'Montant minimum de commande' })
    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    @Transform(({ value }) => Number(value))
    min_order_amount?: number;

    @ApiPropertyOptional({ description: 'Montant maximum de remise' })
    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    @Transform(({ value }) => Number(value))
    max_discount_amount?: number;

    @ApiPropertyOptional({ description: 'Date de début (>=)' })
    @IsOptional()
    @IsDateString()
    start_date_from?: string;

    @ApiPropertyOptional({ description: 'Date de début (<=)' })
    @IsOptional()
    @IsDateString()
    start_date_to?: string;

    @ApiPropertyOptional({ description: 'Date d\'expiration (>=)' })
    @IsOptional()
    @IsDateString()
    expiration_date_from?: string;

    @ApiPropertyOptional({ description: 'Date d\'expiration (<=)' })
    @IsOptional()
    @IsDateString()
    expiration_date_to?: string;

    @ApiPropertyOptional({ description: 'Statut de la promotion' })
    @IsOptional()
    @IsEnum(PromotionStatus)
    status?: PromotionStatus;

    @ApiPropertyOptional({ description: 'Visibilité' })
    @IsOptional()
    @IsEnum(Visibility)
    visibility?: Visibility;

    @ApiPropertyOptional({ description: 'Filtrer par niveau standard' })
    @IsOptional()
    @Type(() => Boolean)
    @IsBoolean()
    @Transform(({ value }) => Boolean(value))
    target_standard?: boolean;

    @ApiPropertyOptional({ description: 'Filtrer par niveau premium' })
    @IsOptional()
    @Type(() => Boolean)
    @IsBoolean()
    @Transform(({ value }) => Boolean(value))
    target_premium?: boolean;

    @ApiPropertyOptional({ description: 'Filtrer par niveau gold' })
    @IsOptional()
    @Type(() => Boolean)
    @IsBoolean()
    @Transform(({ value }) => Boolean(value))
    target_gold?: boolean;

    @ApiPropertyOptional({ description: 'Catégories ciblées' })
    @IsOptional()
    @IsArray()
    @Transform(({ value }) => JSON.parse(value))
    targeted_category_ids?: string[];

    @ApiPropertyOptional({ description: 'Plats ciblés' })
    @IsOptional()
    @IsArray()
    @Transform(({ value }) => JSON.parse(value))
    targeted_dish_ids?: string[];

    @ApiPropertyOptional({ description: 'Restaurants ciblés' })
    @IsOptional()
    @IsArray()
    @Transform(({ value }) => JSON.parse(value))
    restaurant_ids?: string[];

    @ApiPropertyOptional({ description: 'Pagination - page' })
    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    @Transform(({ value }) => Number(value))
    page?: number;

    @ApiPropertyOptional({ description: 'Pagination - limite par page' })
    @IsOptional()
    @Type(() => Number)
    @IsNumber()
    @Transform(({ value }) => Number(value))
    limit?: number;
}
