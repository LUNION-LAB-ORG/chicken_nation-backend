import { IsOptional, IsString, IsNumber, IsEnum, IsUUID } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { TicketPriority } from '@prisma/client';

export class UpdateTicketDto {
    @ApiPropertyOptional({ description: 'Le sujet du ticket' })
    @IsOptional()
    @IsString()
    subject?: string;

    @ApiPropertyOptional({
        description: 'Le niveau de priorité du ticket',
        enum: TicketPriority,
    })
    @IsOptional()
    @IsEnum(TicketPriority)
    priority?: TicketPriority;

    @ApiPropertyOptional({ description: 'L\'ID de la catégorie du ticket' })
    @IsOptional()
    @IsUUID()
    categoryId?: string;

    @ApiPropertyOptional({ description: 'L\'ID de la commande associée au ticket' })
    @IsOptional()
    @IsUUID()
    orderId?: string;
}