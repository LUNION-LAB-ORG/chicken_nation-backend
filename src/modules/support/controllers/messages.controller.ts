import { Body, Controller, Delete, Get, NotFoundException, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { PrismaService } from 'src/database/services/prisma.service';
import { TicketMessageService } from '../services/message.service';
import { FilterQueryDto } from 'src/common/dto/filter-query.dto';
import { CreateTicketMessageDto } from '../dtos/create-ticket-message.dto';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { JwtCustomerAuthGuard } from 'src/modules/auth/guards/jwt-customer-auth.guard';
import type { Request } from 'express';
import { Customer, User, UserRole } from '@prisma/client';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { BasculerReactionDto } from '../../messagerie/dto/reaction.dto';

@ApiTags('Support - Messages')
@Controller('tickets/:ticketId/messages')
export class MessagesController {
    constructor(
        private readonly messageService: TicketMessageService,
        private readonly prisma: PrismaService,
    ) { }

    @UseGuards(JwtAuthGuard)
    @Get()
    async getMessagesByTicketId(@Req() req: Request, @Param('ticketId') ticketId: string, @Query() filter: FilterQueryDto) {
        // Personnel : les notes internes lui sont destinées.
        return this.messageService.getMessagesByTicketId(ticketId, filter, true, (req.user as User)?.id);
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
        // Client : jamais les notes internes du personnel.
        return this.messageService.getMessagesByTicketId(ticketId, filter, false, (req.user as Customer)?.id);
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
    /**
     * RETIRER un message de ticket envoyé par erreur.
     *
     * Suppression douce : la ligne reste, son contenu cesse d'être servi. Les
     * règles fines — son propre message, ou celui d'un collègue si l'on est
     * administrateur, jamais celui d'un client ni d'un livreur — vivent dans
     * le service, seul endroit à connaître l'auteur.
     */
    @UseGuards(JwtAuthGuard)
    @Delete(':messageId')
    @ApiOperation({ summary: 'Retirer un message de ticket (personnel)' })
    async supprimerMessage(
        @Req() req: Request,
        @Param('ticketId') ticketId: string,
        @Param('messageId') messageId: string,
    ) {
        const moi = req.user as User;
        return this.messageService.supprimerMessage({
            ticketId,
            messageId,
            userId: moi.id,
            estAdmin: moi.role === UserRole.ADMIN,
            nom: moi.fullname ?? moi.email ?? null,
            role: moi.role ?? null,
        });
    }

    /**
     * RÉACTION à un message de ticket, côté PERSONNEL.
     *
     * `PUT` : l'opération décrit un état voulu, « ma réaction est celle-ci »,
     * et rejouer la requête ne crée jamais de seconde réaction.
     */
    @UseGuards(JwtAuthGuard)
    @Put(':messageId/reactions')
    @ApiOperation({ summary: 'Réagir à un message de ticket (personnel)' })
    @ApiBody({ type: BasculerReactionDto })
    async basculerReaction(
        @Req() req: Request,
        @Param('ticketId') ticketId: string,
        @Param('messageId') messageId: string,
        @Body() dto: BasculerReactionDto,
    ) {
        return this.messageService.basculerReaction({
            ticketId,
            messageId,
            emoji: dto.emoji,
            userId: (req.user as User).id,
        });
    }

    /** Même opération, côté CLIENT, derrière le contrôle d'appartenance. */
    @UseGuards(JwtCustomerAuthGuard)
    @Put(':messageId/reactions/customer')
    @ApiOperation({ summary: 'Réagir à un message de ticket (client)' })
    @ApiBody({ type: BasculerReactionDto })
    async basculerReactionClient(
        @Req() req: Request,
        @Param('ticketId') ticketId: string,
        @Param('messageId') messageId: string,
        @Body() dto: BasculerReactionDto,
    ) {
        await this.assertTicketDuClient(req, ticketId);
        return this.messageService.basculerReaction({
            ticketId,
            messageId,
            emoji: dto.emoji,
            customerId: (req.user as Customer).id,
        });
    }

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