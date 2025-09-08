import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { CreateTicketDto } from '../dtos/create-ticket.dto';
import { QueryTicketsDto } from '../dtos/query-tickets.dto';
import { TicketService } from '../services/ticket.service';
import { JwtCustomerAuthGuard } from 'src/modules/auth/guards/jwt-customer-auth.guard';

@Controller('tickets')
export class TicketsController {
  constructor(private readonly ticketService: TicketService) { }

  @UseGuards(JwtAuthGuard) @Get()
  async getAllTickets(@Query() filter: QueryTicketsDto) {
    return await this.ticketService.getAllTickets(filter);
  }

  @UseGuards(JwtCustomerAuthGuard) @Get('customer')
  async getCustomerTickets(@Req() req, @Query() filter: QueryTicketsDto) {
    const customerId = req.user.id;
    return await this.ticketService.getCustomerTickets(customerId, filter);
  }

  @UseGuards(JwtAuthGuard) @Get(':id')
  async getTicketById(@Param('id') id: string) {
    return await this.ticketService.getTicketById(id);
  }

  @UseGuards(JwtAuthGuard) @Post()
  async createTicket(@Body() createTicketDto: CreateTicketDto) {
    return await this.ticketService.createTicket(createTicketDto);
  }

  @UseGuards(JwtAuthGuard) @Patch(':id')
  async updateTicket(@Param('id') id: string, @Body() updateData: Partial<CreateTicketDto>) {
    return await this.ticketService.updateTicket(id, updateData);
  }
}
