import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TicketPriority } from '@prisma/client';
import {
    IsEnum,
    IsNotEmpty,
    IsOptional,
    IsString,
    IsUUID,
    MaxLength,
    MinLength,
} from 'class-validator';

/**
 * DTO de création d'un ticket support par un LIVREUR (P-chat livreur).
 *
 * Différences avec CreateTicketDto (qui est customer-centric) :
 *   - Pas de customerId (le delivererId vient du JWT)
 *   - orderId optionnel (le livreur peut référencer une course problématique
 *     ou poser une question générale)
 *   - initialMessage obligatoire — un ticket sans message initial n'a pas de sens
 *   - source par défaut = 'mobile_deliverer'
 */
export class CreateDelivererTicketDto {
    @ApiProperty({ description: 'Sujet du ticket (10-200 caractères)' })
    @IsString()
    @IsNotEmpty()
    @MinLength(5)
    @MaxLength(200)
    subject: string;

    @ApiProperty({ description: 'UUID de la catégorie du ticket (problème livraison, paiement, etc.)' })
    @IsUUID()
    @IsNotEmpty()
    categoryId: string;

    @ApiProperty({
        description: "Premier message du livreur expliquant le problème (10-2000 caractères)",
    })
    @IsString()
    @IsNotEmpty()
    @MinLength(5)
    @MaxLength(2000)
    initialMessage: string;

    @ApiPropertyOptional({
        description: 'UUID de la course liée si le ticket concerne une course spécifique',
    })
    @IsUUID()
    @IsOptional()
    courseId?: string;

    @ApiPropertyOptional({
        description: 'Priorité — par défaut MEDIUM. Le livreur peut signaler URGENT.',
        enum: TicketPriority,
    })
    @IsEnum(TicketPriority)
    @IsOptional()
    priority?: TicketPriority;
}
