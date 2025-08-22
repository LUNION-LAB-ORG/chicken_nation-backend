import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { MessageService } from '../services/message.service';
import { QueryMessagesDto } from '../dtos/query-messages.dto';
import { Request } from 'express';
import { CreateMessageDto } from '../dto/createMessageDto';

@Controller('conversations/:conversationId/messages')
export class MessageController {
  constructor(private readonly messageService: MessageService) {}

  @Get()
  async getMessages(
    @Req() req: Request,
    @Param('conversationId') conversationId: string,
    filter: QueryMessagesDto={},
  ) {
    return await this.messageService.getMessages(req, conversationId, filter);
  }

  @Post()
  async createMessage(
    @Req() req: Request,
    @Param('conversationId') conversationId: string,
    @Body() createMessageDto: CreateMessageDto,
  ) {
    return await this.messageService.createMessage(req, conversationId, createMessageDto);
  }
}
