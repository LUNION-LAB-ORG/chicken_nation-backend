import { Body, Controller, Get, NotFoundException, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { PrismaService } from 'src/database/services/prisma.service';
import { TicketMessageService } from '../services/message.service';
import { FilterQueryDto } from 'src/common/dto/filter-query.dto';
import { CreateTicketMessageDto } from '../dtos/create-ticket-message.dto';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { JwtCustomerAuthGuard } from 'src/modules/auth/guards/jwt-customer-auth.guard';
import type { Request } from 'express';
import { Customer, User } from '@prisma/client';
import { ApiTags } from '@nestjs/swagger';

@ApiTags('Support - Messages')
@Controller('tickets/:ticketId/messages')
export class MessagesController {
    constructor(
        private readonly messageService: TicketMessageService,
        private readonly prisma: PrismaService,
    ) { }

    @UseGuards(JwtAuthGuard)
    @Get()
    async getMessagesByTicketId(@Param('ticketId') ticketId: string, @Query() filter: FilterQueryDto) {
        return this.messageService.getMessagesByTicketId(ticketId, filter);
    }

    /**
     * ⚠️ FAILLE CORRIGEE : le ticket venait de l'URL, jamais confronté au client
     * du jeton. Tout client de l'application lisait le fil de support de
     * n'importe qui, avec son contenu et ses pièces jointes.
     */
    @UseGuards(JwtCustomerAuthGuard)
    @Get('customer')
    async getCustomerMessagesByTicketId(@Req() req: Request, @Param('ticketId') ticketId: string, @Query() filter: FilterQueryDto) {
        await this.assertTicketDuClient(req, ticketId);
        return this.messageService.getMessagesByTicketId(ticketId, filter);
    }

    /**
     * ⚠️ FAILLE CORRIGEE : seul `authorType` était forcé ; `authorId` restait un
     * champ du CORPS de la requête. Tout membre du personnel signait donc un
     * message au nom d'un autre agent. L'auteur vient désormais du jeton.
     */
    @UseGuards(JwtAuthGuard)
    @Post()
    async createMessage(@Req() req: Request, @Param('ticketId') ticketId: string, @Body() createMessageDto: CreateTicketMessageDto) {
        createMessageDto.authorType = 'USER';
        createMessageDto.authorId = (req.user as User).id;
        return this.messageService.createMessage(ticketId, createMessageDto);
    }

    /**
     * ⚠️ FAILLE CORRIGEE, double : ni l'appartenance du ticket ni l'auteur
     * n'étaient contrôlés. Un client écrivait dans le fil de support d'autrui,
     * et pouvait signer au nom de n'importe qui en posant `authorId` dans le
     * corps. `internal` est forcé à faux : une note interne écrite par un
     * client n'a aucun sens.
     */
    @UseGuards(JwtCustomerAuthGuard)
    @Post('customer')
    async createCustomerMessage(@Req() req: Request, @Param('ticketId') ticketId: string, @Body() createMessageDto: CreateTicketMessageDto) {
        await this.assertTicketDuClient(req, ticketId);
        createMessageDto.authorType = 'CUSTOMER';
        createMessageDto.authorId = (req.user as Customer).id;
        (createMessageDto as any).internal = false;
        return this.messageService.createMessage(ticketId, createMessageDto);
    }

    @UseGuards(JwtAuthGuard)
    @Post('read')
    async markMessagesAsRead(@Req() req: Request, @Param('ticketId') ticketId: string) {
        return this.messageService.markMessagesAsRead(ticketId, "USER", (req.user as User).id);
    }

    @UseGuards(JwtCustomerAuthGuard)
    @Post('customer/read')
    async markCustomerMessagesAsRead(@Req() req: Request, @Param('ticketId') ticketId: string) {
        await this.assertTicketDuClient(req, ticketId);
        return this.messageService.markMessagesAsRead(ticketId, "CUSTOMER", (req.user as Customer).id);
    }

    /**
     * Refuse l'accès si le ticket n'appartient pas au client du jeton.
     * « Introuvable » plutôt qu'« interdit », pour ne pas confirmer l'existence
     * d'un identifiant à qui l'énumère.
     */
    private async assertTicketDuClient(req: Request, ticketId: string) {
        const ticket = await this.prisma.ticketThread.findUnique({
            where: { id: ticketId },
            select: { customerId: true },
        });
        const customerId = (req.user as Customer)?.id;
        if (!ticket || ticket.customerId !== customerId) {
            throw new NotFoundException('Ticket introuvable');
        }
    }
}