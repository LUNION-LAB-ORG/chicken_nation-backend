import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { TicketMessageService } from '../services/message.service';
import { FilterQueryDto } from 'src/common/dto/filter-query.dto';
import { CreateTicketMessageDto } from '../dtos/create-ticket-message.dto';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { JwtCustomerAuthGuard } from 'src/modules/auth/guards/jwt-customer-auth.guard';

@Controller(':ticketId/messages')
export class MessagesController {
    constructor(private readonly messageService: TicketMessageService) { }

    @UseGuards(JwtAuthGuard)
    @Get('messages')
    async getMessagesByTicketId(@Param('ticketId') ticketId: string, @Query() filter: FilterQueryDto) {
        return this.messageService.getMessagesByTicketId(ticketId, filter);
    }

    @UseGuards(JwtCustomerAuthGuard)
    @Get('customer/messages')
    async getCustomerMessagesByTicketId(@Param('ticketId') ticketId: string, @Query() filter: FilterQueryDto) {
        return this.messageService.getMessagesByTicketId(ticketId, filter);
    }

    @UseGuards(JwtAuthGuard)
    @Post('messages')
    async createMessage(@Param('ticketId') ticketId: string, @Body() createMessageDto: CreateTicketMessageDto) {
        createMessageDto.authorType = 'USER';
        return this.messageService.createMessage(ticketId, createMessageDto);
    }

    @UseGuards(JwtCustomerAuthGuard)
    @Post('customer/messages')
    async createCustomerMessage(@Param('ticketId') ticketId: string, @Body() createMessageDto: CreateTicketMessageDto) {
        createMessageDto.authorType = 'CUSTOMER';
        return this.messageService.createMessage(ticketId, createMessageDto);
    }
}
