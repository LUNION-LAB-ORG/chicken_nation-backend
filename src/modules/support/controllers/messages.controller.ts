import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { TicketMessageService } from '../services/message.service';
import { FilterQueryDto } from 'src/common/dto/filter-query.dto';
import { CreateTicketMessageDto } from '../dtos/create-ticket-message.dto';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { JwtCustomerAuthGuard } from 'src/modules/auth/guards/jwt-customer-auth.guard';
import { Request } from 'express';
import { Customer, User } from '@prisma/client';
import { ApiTags } from '@nestjs/swagger';

@ApiTags('Support - Messages')
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

    @UseGuards(JwtAuthGuard)
    @Post('messages/read')
    async markMessagesAsRead(@Req() req: Request, @Param('ticketId') ticketId: string) {
        return this.messageService.markMessagesAsRead(ticketId, "USER", (req.user as User).id);
    }

    @UseGuards(JwtCustomerAuthGuard)
    @Post('customer/messages/read')
    async markCustomerMessagesAsRead(@Req() req: Request, @Param('ticketId') ticketId: string) {
        return this.messageService.markMessagesAsRead(ticketId, "CUSTOMER", (req.user as Customer).id);
    }
}