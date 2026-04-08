import { IsOptional, IsEnum, IsString, IsUUID, IsIn } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { EntityStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';

export const CUSTOMER_SEGMENTS = [
    'all',               // Tous les clients
    'app_users',         // Ont l'app installée (expo_push_token)
    'no_app',            // N'ont pas l'app (pas de expo_push_token)
    'has_ordered',       // Ont déjà commandé
    'never_ordered',     // Jamais commandé
    'incomplete_profile', // Nom ou prénom manquant
] as const;

export type CustomerSegment = (typeof CUSTOMER_SEGMENTS)[number];

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

    @ApiPropertyOptional({ description: 'Filtrer par ID de restaurant' })
    @IsOptional()
    @IsUUID()
    restaurantId?: string;

    @ApiPropertyOptional({
        description: 'Segment prédéfini',
        enum: CUSTOMER_SEGMENTS,
    })
    @IsOptional()
    @IsString()
    @IsIn(CUSTOMER_SEGMENTS)
    segment?: CustomerSegment;
}