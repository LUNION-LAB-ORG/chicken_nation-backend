import {
  Body,
  Controller,
  Get,
  Logger,
  Param,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Customer, User } from '@prisma/client';
import { Request } from 'express';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Action } from 'src/modules/auth/enums/action.enum';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { JwtCustomerAuthGuard } from '../../auth/guards/jwt-customer-auth.guard';
import { CreateMessageDto } from '../dto/createMessageDto';
import { QueryMessagesDto } from '../dto/query-messages.dto';
import { MessageService } from '../services/message.service';

@Controller('conversations/:conversationId/messages')
export class MessageController {
  private readonly logger = new Logger(MessageController.name);
  private readonly isDev = process.env.NODE_ENV !== 'production';
  constructor(private readonly messageService: MessageService) {}

  @Get()
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.MESSAGES, Action.READ)
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
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.MESSAGES, Action.CREATE)
  @UseInterceptors(FileInterceptor('image'))
  async createMessage(
    @Req() req: Request,
    @Param('conversationId') conversationId: string,
    @Body() createMessageDto: CreateMessageDto,
    @UploadedFile() image: Express.Multer.File,
  ) {
    return this.handleCreateMessage(
      req,
      conversationId,
      createMessageDto,
      image,
    );
  }

  // --- Client : création de ses propres messages ---
  @Post('/client')
  @UseGuards(JwtCustomerAuthGuard)
  @UseInterceptors(FileInterceptor('image'))
  async createMessageClient(
    @Req() req: Request,
    @Param('conversationId') conversationId: string,
    @Body() createMessageDto: CreateMessageDto,
    @UploadedFile() image?: Express.Multer.File, // image peut être undefined ici
  ) {
    return this.handleCreateMessage(
      req,
      conversationId,
      createMessageDto,
      image,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post('messages/read')
  async markMessagesAsRead(
    @Req() req: Request,
    @Param('ticketId') ticketId: string,
  ) {
    return this.messageService.markMessagesAsRead(
      ticketId,
      'USER',
      (req.user as User).id,
    );
  }

  @UseGuards(JwtCustomerAuthGuard)
  @Post('customer/messages/read')
  async markCustomerMessagesAsRead(
    @Req() req: Request,
    @Param('ticketId') ticketId: string,
  ) {
    return this.messageService.markMessagesAsRead(
      ticketId,
      'CUSTOMER',
      (req.user as Customer).id,
    );
  }

  private async handleCreateMessage(
    req: Request,
    conversationId: string,
    createMessageDto: CreateMessageDto,
    image?: Express.Multer.File,
  ) {
    if (this.isDev) {
      this.logger.debug(
        `Requête de création de message reçue: ${JSON.stringify(createMessageDto)}`,
      );
      if (image) {
        this.logger.debug(`Image reçue: ${JSON.stringify(image)}`);
      }
    }

    return await this.messageService.createMessage(
      req,
      conversationId,
      createMessageDto,
      image,
    );
  }
}
