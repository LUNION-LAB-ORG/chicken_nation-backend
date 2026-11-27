import { AssignmentService } from './../services/assignment.service';
import { Body, Controller, Get, HttpException, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { CreateTicketDto } from '../dtos/create-ticket.dto';
import { QueryTicketsDto } from '../dtos/query-tickets.dto';
import { TicketService } from '../services/ticket.service';
import { JwtCustomerAuthGuard } from 'src/modules/auth/guards/jwt-customer-auth.guard';
import { UpdateTicketDto } from '../dtos/update-ticket.dto';
import { assignTicketDto } from '../dtos/assign-ticket.dto';

@Controller('tickets')
export class TicketsController {
  constructor(
    private readonly ticketService: TicketService,
    private readonly assignmentService: AssignmentService,
  ) { }

  @UseGuards(JwtAuthGuard) @Get()
  async getAllTickets(@Req() req, @Query() filter: QueryTicketsDto) {
    // Les utilisateurs RESTAURANT ne voient que les tickets liés à leur restaurant
    const user = req.user;
    if (user?.type === 'RESTAURANT' && user?.restaurant_id) {
      filter.restaurantId = user.restaurant_id;
    }
    return await this.ticketService.getAllTickets(filter);
  }

  @UseGuards(JwtCustomerAuthGuard) @Get('/customer')
  async getCustomerTickets(@Req() req, @Query() filter: QueryTicketsDto) {
    const customerId = req.user.id;
    return await this.ticketService.getCustomerTickets(customerId, filter);
  }

  /**
   * La demande EN COURS du client pour une commande (27/11) : « Support »
   * depuis une commande la rouvre au lieu d'en créer une autre.
   * Réponse : `{ ticket }`, `null` quand il n'y en a pas.
   */
  @UseGuards(JwtCustomerAuthGuard) @Get('/customer/en-cours')
  async getCustomerTicketEnCours(
    @Req() req,
    @Query('orderId', new ParseUUIDPipe({ exceptionFactory: () => new NotFoundException('Commande introuvable') }))
    orderId: string,
  ) {
    return { ticket: await this.ticketService.getCustomerTicketEnCours(req.user.id, orderId) };
  }

  /** Un ticket du client (statut, commande, catégorie), sans les notes internes. */
  @UseGuards(JwtCustomerAuthGuard) @Get('/customer/:id')
  async getCustomerTicket(
    @Req() req,
    @Param('id', new ParseUUIDPipe({ exceptionFactory: () => new NotFoundException('Ticket introuvable') }))
    id: string,
  ) {
    return await this.ticketService.getCustomerTicket(req.user.id, id);
  }

  @UseGuards(JwtAuthGuard) @Get('stats')
  async getTicketStats(@Req() req) {
    const user = req.user;
    const restaurantId = user?.type === 'RESTAURANT' && user?.restaurant_id ? user.restaurant_id : undefined;
    return await this.ticketService.getTicketStats(restaurantId);
  }

  @UseGuards(JwtAuthGuard) @Get(':id')
  async getTicketById(@Req() req, @Param('id') id: string) {
    const ticket = await this.ticketService.getTicketById(id);
    // Vérifier que le restaurant ne consulte pas un ticket d'un autre restaurant
    const user = req.user;
    if (user?.type === 'RESTAURANT' && user?.restaurant_id) {
      if (ticket.order?.restaurantId && ticket.order.restaurantId !== user.restaurant_id) {
        throw new HttpException('Accès interdit à ce ticket', 403);
      }
    }
    return ticket;
  }

  @UseGuards(JwtAuthGuard) @Post()
  async createTicket(@Body() createTicketDto: CreateTicketDto) {
    return await this.ticketService.createTicket(createTicketDto);
  }

  // Le client creer un ticket (1 seul ticket "en cours" autorisé à la fois)
  @UseGuards(JwtCustomerAuthGuard) @Post('/customer')
  async createCustomerTicket(@Req() req, @Body() createTicketDto: CreateTicketDto) {
    createTicketDto.customerId = req.user.id;
    return await this.ticketService.createTicket(createTicketDto, {
      enforceSingleOpenCustomer: true,
    });
  }

  @UseGuards(JwtAuthGuard) @Patch(':id')
  async updateTicket(@Param('id') id: string, @Body() updateData: UpdateTicketDto) {
    return await this.ticketService.updateTicket(id, updateData);
  }

  @UseGuards(JwtAuthGuard) @Post(':id/assign')
  async assignTicket(@Param('id') id: string, @Body() assignTicketDto: assignTicketDto) {
    return await this.assignmentService.assignTicketToAgent(id, assignTicketDto.assigneeId);
  }

  @UseGuards(JwtAuthGuard) @Post(':id/close')
  async closeTicket(@Param('id') id: string) {
    return await this.ticketService.closeTicket(id);
  }

  // Le staff ouvre un ticket → marque comme lus les messages entrants
  // (client / livreur) pour vider le badge "non lus". Appelé par le backoffice
  // (TicketView) à l'ouverture.
  @UseGuards(JwtAuthGuard) @Post(':id/messages/read')
  async markMessagesRead(@Param('id') id: string) {
    return await this.ticketService.markMessagesAsRead(id);
  }
}
