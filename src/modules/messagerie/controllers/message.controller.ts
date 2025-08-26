import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { MessageService } from '../services/message.service';
import { QueryMessagesDto } from '../dto/query-messages.dto';
import { Request } from 'express';
import { CreateMessageDto } from '../dto/createMessageDto';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { JwtCustomerAuthGuard } from '../../auth/guards/jwt-customer-auth.guard';

@Controller('conversations/:conversationId/messages')
export class MessageController {
  constructor(private readonly messageService: MessageService) {}

  @UseGuards(JwtAuthGuard)
  @Get()
  async getMessages(
    @Req() req: Request,
    @Param('conversationId') conversationId: string,
    filter: QueryMessagesDto={},
  ) {
    return await this.messageService.getMessages(req, conversationId, filter);
  }

  @UseGuards(JwtCustomerAuthGuard)
  @Get('/client')
  async getMessagesClient(
    @Req() req: Request,
    @Param('conversationId') conversationId: string,
    filter: QueryMessagesDto={},
  ) {
    return await this.messageService.getMessages(req, conversationId, filter);
  }

  @UseGuards(JwtAuthGuard)
  @Post()
  async createMessage(
    @Req() req: Request,
    @Param('conversationId') conversationId: string,
    @Body() createMessageDto: CreateMessageDto,
  ) {
    return await this.messageService.createMessage(req, conversationId, createMessageDto);
  }

  @UseGuards(JwtCustomerAuthGuard)
  @Post('/client')
  async createMessageClient(
    @Req() req: Request,
    @Param('conversationId') conversationId: string,
    @Body() createMessageDto: CreateMessageDto,
  ) {
    return await this.messageService.createMessage(req, conversationId, createMessageDto);
  }
}
