import {
    Body,
    Controller,
    Get,
    Param,
    ParseUUIDPipe,
    Patch,
    Post,
    Query,
    UseGuards,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Deliverer } from '@prisma/client';

import { CurrentDeliverer } from 'src/modules/auth-deliverer/decorators/current-deliverer.decorator';
import { JwtDelivererAuthGuard } from 'src/modules/auth-deliverer/guards/jwt-deliverer-auth.guard';
import { FilterQueryDto } from 'src/common/dto/filter-query.dto';

import { CreateDelivererTicketDto } from '../dtos/create-deliverer-ticket.dto';
import { CreateTicketMessageDto } from '../dtos/create-ticket-message.dto';
import { QueryTicketsDto } from '../dtos/query-tickets.dto';
import { DelivererTicketsService } from '../services/deliverer-tickets.service';
import { TicketMessageService } from '../services/message.service';

/**
 * Endpoints support tickets dédiés AU LIVREUR connecté (P-chat livreur).
 *
 * Préfixe : `/tickets/deliverer/me/*` — déclaré AVANT les routes admin
 * `/tickets/:id` pour éviter la collision (cf. fix DeliverersSelfController).
 *
 * Auth : JwtDelivererAuthGuard (token livreur dédié).
 */
@ApiTags('Tickets — Livreur')
@Controller('tickets/deliverer/me')
@UseGuards(JwtDelivererAuthGuard)
export class DelivererTicketsController {
    constructor(
        private readonly ticketsService: DelivererTicketsService,
        private readonly messageService: TicketMessageService,
    ) { }

    @ApiOperation({ summary: 'Liste paginée de mes tickets support' })
    @Get()
    async listMyTickets(
        @CurrentDeliverer() deliverer: Deliverer,
        @Query() filter: QueryTicketsDto,
    ) {
        return this.ticketsService.getMyTickets(deliverer.id, filter);
    }

    @ApiOperation({ summary: 'Créer un nouveau ticket support' })
    @ApiBody({ type: CreateDelivererTicketDto })
    @Post()
    async createTicket(
        @CurrentDeliverer() deliverer: Deliverer,
        @Body() dto: CreateDelivererTicketDto,
    ) {
        return this.ticketsService.createTicket(deliverer.id, dto);
    }

    @ApiOperation({ summary: "Détail d'un de mes tickets" })
    @Get(':id')
    async getTicketDetail(
        @CurrentDeliverer() deliverer: Deliverer,
        @Param('id', new ParseUUIDPipe()) id: string,
    ) {
        return this.ticketsService.getTicketDetail(id, deliverer.id);
    }

    @ApiOperation({
        summary: "Liste paginée des messages d'un de mes tickets",
        description: "Vérifie automatiquement que le ticket m'appartient avant de retourner les messages.",
    })
    @Get(':id/messages')
    async getMessages(
        @CurrentDeliverer() deliverer: Deliverer,
        @Param('id', new ParseUUIDPipe()) id: string,
        @Query() filter: FilterQueryDto,
    ) {
        // Garde : vérifie l'appartenance via getTicketDetail (qui throw 403 sinon)
        await this.ticketsService.getTicketDetail(id, deliverer.id);
        return this.messageService.getMessagesByTicketId(id, filter);
    }

    @ApiOperation({ summary: 'Envoyer un message dans un de mes tickets' })
    @Post(':id/messages')
    async sendMessage(
        @CurrentDeliverer() deliverer: Deliverer,
        @Param('id', new ParseUUIDPipe()) id: string,
        @Body() body: { body: string; meta?: string },
    ) {
        await this.ticketsService.getTicketDetail(id, deliverer.id);

        const dto: CreateTicketMessageDto = {
            ticketId: id,
            body: body.body,
            internal: false,
            authorId: deliverer.id,
            authorType: 'DELIVERER',
            meta: body.meta,
        };

        return this.messageService.createMessage(id, dto);
    }

    @ApiOperation({
        summary: 'Marquer mes messages comme lus dans un ticket',
        description: 'Idempotent : marque comme lus tous les messages NON envoyés par moi.',
    })
    @Patch(':id/messages/read')
    async markMessagesAsRead(
        @CurrentDeliverer() deliverer: Deliverer,
        @Param('id', new ParseUUIDPipe()) id: string,
    ) {
        await this.ticketsService.getTicketDetail(id, deliverer.id);
        return this.messageService.markMessagesAsRead(id, 'DELIVERER', deliverer.id);
    }

    @ApiOperation({
        summary: 'Fermer un de mes tickets (statut → CLOSED)',
        description: "Marque le ticket comme résolu côté livreur. L'admin peut le rouvrir si besoin.",
    })
    @Patch(':id/close')
    async closeMyTicket(
        @CurrentDeliverer() deliverer: Deliverer,
        @Param('id', new ParseUUIDPipe()) id: string,
    ) {
        return this.ticketsService.closeMyTicket(id, deliverer.id);
    }
}
