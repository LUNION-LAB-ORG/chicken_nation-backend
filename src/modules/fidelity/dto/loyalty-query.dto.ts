import { ApiPropertyOptional } from '@nestjs/swagger';
import { LoyaltyPointType } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
    IsBoolean,
    IsEnum,
    IsNumber,
    IsOptional,
    IsString,
    IsUUID
} from 'class-validator';

export class LoyaltyQueryDto {
    @ApiPropertyOptional({ description: 'ID du client' })
    @IsOptional()
    @IsUUID()
    customer_id?: string;

    @ApiPropertyOptional({ description: 'Type de points' })
    @IsOptional()
    @IsEnum(LoyaltyPointType)
    type?: LoyaltyPointType;

    @ApiPropertyOptional({ description: 'Utilisés' })
    @IsOptional()
    @IsBoolean()
    is_used?: boolean;

    @ApiPropertyOptional({ description: 'Recherche' })
    @IsOptional()
    @IsString()
    search?: string;
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
