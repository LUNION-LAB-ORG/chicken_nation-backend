import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TicketPriority, TicketStatus } from '@prisma/client';
import {
    IsEnum,
    IsNotEmpty,
    IsOptional,
    IsString,
    IsUUID,
} from 'class-validator';

export class CreateTicketDto {
    @ApiProperty({ description: 'Sujet du ticket' })
    @IsString()
    @IsNotEmpty()
    subject: string;

    @ApiPropertyOptional({ description: 'Statut du ticket' })
    @IsEnum(TicketStatus)
    @IsOptional()
    status?: TicketStatus;

    @ApiPropertyOptional({ description: 'Priorité du ticket' })
    @IsEnum(TicketPriority)
    @IsOptional()
    priority?: TicketPriority;

    @ApiPropertyOptional({ description: 'Catégorie du ticket (ex: DELIVERY, BILLING, QUALITY)' })
    @IsString()
    @IsNotEmpty()
    category: string;

    @ApiPropertyOptional({ description: 'Source du ticket (ex: phone, email, webform, escalation)' })
    @IsString()
    @IsOptional()
    source?: string;

    @ApiPropertyOptional({ description: 'ID du client' })
    @IsUUID()
    @IsOptional()
    customerId?: string;

    @ApiPropertyOptional({ description: 'ID de l\'agent assigné' })
    @IsUUID()
    @IsOptional()
    assigneeId?: string;

    @ApiPropertyOptional({ description: 'ID de la conversation d\'origine' })
    @IsUUID()
    @IsOptional()
    fromConversationId?: string;

    @ApiProperty({ description: 'ID de la commande liée au ticket' })
    @IsUUID()
    @IsNotEmpty()
    orderId: string;
}