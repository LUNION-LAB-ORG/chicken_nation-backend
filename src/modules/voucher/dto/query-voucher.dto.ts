import { ApiPropertyOptional } from "@nestjs/swagger";
import { VoucherStatus } from "@prisma/client";
import { Type } from "class-transformer";
import { IsEnum, IsNumber, IsOptional, IsString, IsUUID, Min } from "class-validator";

export class QueryVoucherDto {
    @ApiPropertyOptional({ description: "Rechercher un bon par son code" })
    @IsOptional()
    @IsString()
    code?: string;

    @ApiPropertyOptional({ description: "Filtrer par statut" })
    @IsOptional()
    @IsEnum(VoucherStatus)
    status?: VoucherStatus;

    @ApiPropertyOptional({ description: "Filtrer par ID de client" })
    @IsOptional()
    @IsUUID()
    customerId?: string;

    @ApiPropertyOptional({ description: "Filtrer par montant initial minimum" })
    @Min(0)
    @Type(() => Number)
    @IsOptional()
    @IsNumber()
    minInitialAmount?: number;

    @ApiPropertyOptional({ description: "Filtrer par montant initial maximum" })
    @Min(0)
    @Type(() => Number)
    @IsOptional()
    @IsNumber()
    maxInitialAmount?: number;

    @ApiPropertyOptional({ description: "Filtrer par montant restant minimum" })
    @Min(0)
    @Type(() => Number)
    @IsOptional()
    @IsNumber()
    minRemainingAmount?: number;

    @ApiPropertyOptional({ description: "Filtrer par montant restant maximum" })
    @Min(0)
    @Type(() => Number)
    @IsOptional()
    @IsNumber()
    maxRemainingAmount?: number;

    @ApiPropertyOptional({ description: "Filtrer par date d'expiration minimum" })
    @IsOptional()
    minExpiresAt?: Date;

    @ApiPropertyOptional({ description: "Filtrer par date d'expiration maximum" })
    @IsOptional()
    maxExpiresAt?: Date;

    @ApiPropertyOptional({ description: "Numéro de page pour la pagination" })
    @IsOptional()
    @IsNumber()
    @Type(() => Number)
    page?: number = 1;

    @ApiPropertyOptional({ description: "Nombre d'éléments par page" })
    @IsOptional()
    @IsNumber()
    @Type(() => Number)
    limit?: number = 10;

    @ApiPropertyOptional({ description: "Champ de tri", default: "created_at" })
    @IsOptional()
    @IsString()
    sortBy?: string;

    @ApiPropertyOptional({ description: "Ordre de tri", default: "asc" })
    @IsString()
    @IsOptional()
    sortOrder?: 'asc' | 'desc';
}