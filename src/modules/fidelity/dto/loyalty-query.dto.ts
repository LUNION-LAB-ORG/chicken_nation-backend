import { ApiPropertyOptional } from '@nestjs/swagger';
import { LoyaltyPointType } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
    IsEnum,
    IsIn,
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

    @ApiPropertyOptional({ description: 'Type de points', enum: LoyaltyPointType })
    @IsOptional()
    @IsEnum(LoyaltyPointType)
    type?: LoyaltyPointType;

    @ApiPropertyOptional({ description: 'Statut d\'utilisation: available, used, partial, all' })
    @IsOptional()
    @IsIn(['all', 'available', 'used', 'partial'])
    is_used?: 'all' | 'available' | 'used' | 'partial';

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
