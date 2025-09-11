import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { MessageService } from '../services/message.service';
import { QueryMessagesDto } from '../dto/query-messages.dto';
import { Request } from 'express';
import { CreateMessageDto } from '../dto/createMessageDto';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { JwtCustomerAuthGuard } from '../../auth/guards/jwt-customer-auth.guard';
import { UserRole } from '@prisma/client';
import { PermissionsGuard } from 'src/common/guards/user-module-permissions-guard';
import { UserRoles } from 'src/common/decorators/user-roles.decorator';
import { RequirePermission } from 'src/common/decorators/user-require-permission';

@Controller('conversations/:conversationId/messages')
export class MessageController {
  constructor(private readonly messageService: MessageService) {}

  // --- Staff (admin, call_center) : lecture des messages ---
  @Get()
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @UserRoles(UserRole.ADMIN, UserRole.CALL_CENTER)
  @RequirePermission('messages', 'read')
  async getMessages(
    @Req() req: Request,
    @Param('conversationId') conversationId: string,
    @Query() filter: QueryMessagesDto = {},
  ) {
    return await this.messageService.getMessages(req, conversationId, filter);
  }

  // --- Client : lecture de ses propres messages ---
  @Get('/client')
  @UseGuards(JwtCustomerAuthGuard)
  async getMessagesClient(
    @Req() req: Request,
    @Param('conversationId') conversationId: string,
    @Query() filter: QueryMessagesDto = {},
  ) {
    return await this.messageService.getMessages(req, conversationId, filter);
  }

  // --- Staff (admin seulement) : création de messages ---
  @Post()
  @UseGuards(JwtAuthGuard, PermissionsGuard)
  @UserRoles(UserRole.ADMIN)
  @RequirePermission('messages', 'create')
  async createMessage(
    @Req() req: Request,
    @Param('conversationId') conversationId: string,
    @Body() createMessageDto: CreateMessageDto,
  ) {
    return await this.messageService.createMessage(req, conversationId, createMessageDto);
  }

  // --- Client : création de ses propres messages ---
  @Post('/client')
  @UseGuards(JwtCustomerAuthGuard)
  async createMessageClient(
    @Req() req: Request,
    @Param('conversationId') conversationId: string,
    @Body() createMessageDto: CreateMessageDto,
  ) {
    return await this.messageService.createMessage(req, conversationId, createMessageDto);
  }
}
