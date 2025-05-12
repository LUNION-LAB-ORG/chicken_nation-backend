import { IsOptional, IsEnum, IsString, IsUUID } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { EntityStatus, PaiementStatus } from '@prisma/client';
import { Transform } from 'class-transformer';

export class QueryPaiementDto {
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
    @Transform(({ value }) => String(value).toUpperCase().trim() as EntityStatus)
    status?: EntityStatus = EntityStatus.ACTIVE;

    @ApiPropertyOptional({ description: 'État du paiement', enum: PaiementStatus, default: PaiementStatus.REVERTED })
    @IsEnum(PaiementStatus)
    @IsOptional()
    @Transform(({ value }) => String(value).toUpperCase().trim() as PaiementStatus)
    state?: PaiementStatus = PaiementStatus.SUCCESS;

    @ApiPropertyOptional({ description: 'Id de la commande' })
    @IsUUID()
    @IsOptional()
    @Transform(({ value }) => String(value).trim())
    order_id?: string;

    @ApiPropertyOptional({ description: 'Termes de recherche (nom, email, téléphone)' })
    @IsString()
    @IsOptional()
    @Transform(({ value }) => String(value).trim())
    search?: string;
}