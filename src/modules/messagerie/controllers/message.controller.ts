import {
  Body,
  Controller,
  Get,
  Logger,
  Param,
  Post,
  Put,
  Query,
  Req,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBody, ApiOperation } from '@nestjs/swagger';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { Customer, User } from '@prisma/client';
import type { Request } from 'express';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Action } from 'src/modules/auth/enums/action.enum';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { BasculerReactionDto } from '../dto/reaction.dto';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { JwtCustomerAuthGuard } from '../../auth/guards/jwt-customer-auth.guard';
import {
  CHAMPS_PIECES_JOINTES,
  OPTIONS_PIECES_JOINTES,
  PiecesJointesMessage,
} from '../utils/pieces-jointes';
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
  @UseInterceptors(
    FileFieldsInterceptor(CHAMPS_PIECES_JOINTES, OPTIONS_PIECES_JOINTES),
  )
  async createMessage(
    @Req() req: Request,
    @Param('conversationId') conversationId: string,
    @Body() createMessageDto: CreateMessageDto,
    @UploadedFiles() fichiers: PiecesJointesMessage,
  ) {
    return this.handleCreateMessage(
      req,
      conversationId,
      createMessageDto,
      fichiers,
    );
  }

  // --- Client : création de ses propres messages ---
  @Post('/client')
  @UseGuards(JwtCustomerAuthGuard)
  @UseInterceptors(
    FileFieldsInterceptor(CHAMPS_PIECES_JOINTES, OPTIONS_PIECES_JOINTES),
  )
  async createMessageClient(
    @Req() req: Request,
    @Param('conversationId') conversationId: string,
    @Body() createMessageDto: CreateMessageDto,
    @UploadedFiles() fichiers?: PiecesJointesMessage,
  ) {
    return this.handleCreateMessage(
      req,
      conversationId,
      createMessageDto,
      fichiers,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post('read')
  async markMessagesAsRead(
    @Req() req: Request,
    @Param('conversationId') conversationId: string,
  ) {
    return this.messageService.markMessagesAsRead(
      conversationId,
      'USER',
      (req.user as User).id,
    );
  }

  @UseGuards(JwtCustomerAuthGuard)
  @Post('customer/read')
  async markCustomerMessagesAsRead(
    @Req() req: Request,
    @Param('conversationId') conversationId: string,
  ) {
    return this.messageService.markMessagesAsRead(
      conversationId,
      'CUSTOMER',
      (req.user as Customer).id,
    );
  }

  private async handleCreateMessage(
    req: Request,
    conversationId: string,
    createMessageDto: CreateMessageDto,
    fichiers?: PiecesJointesMessage,
  ) {
    const image = fichiers?.image?.[0];
    const audio = fichiers?.audio?.[0];
    if (this.isDev) {
      this.logger.debug(
        `Requête de création de message reçue: ${JSON.stringify(createMessageDto)}`,
      );
      if (image) this.logger.debug(`Image reçue: ${image.originalname}`);
      if (audio) this.logger.debug(`Audio reçu: ${audio.originalname}`);
    }

    return await this.messageService.createMessage(
      req,
      conversationId,
      createMessageDto,
      image,
      audio,
    );
  }

  /**
   * RÉACTION à un message, comme sur WhatsApp : poser, remplacer, retirer.
   *
   * `PUT` et non `POST` : l'opération est idempotente au sens où elle décrit un
   * état voulu, « ma réaction à ce message est celle-ci », et rejouer la même
   * requête ne crée jamais de seconde réaction.
   *
   * ⚠️ Permission `READ` et non `UPDATE` : réagir n'est pas modifier la
   * conversation, et `Modules.MESSAGES` en UPDATE ouvrirait au passage les
   * catégories de tickets du support, donc le routage de tout le réseau. La
   * règle réelle, être participant ou du restaurant, est appliquée dans le
   * service, seul endroit à connaître la composition de la conversation.
   */
  @Put(':messageId/reactions')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.MESSAGES, Action.READ)
  @ApiOperation({ summary: 'Réagir à un message (personnel)' })
  @ApiBody({ type: BasculerReactionDto })
  async basculerReaction(
    @Req() req: Request,
    @Param('conversationId') conversationId: string,
    @Param('messageId') messageId: string,
    @Body() dto: BasculerReactionDto,
  ) {
    return await this.messageService.basculerReaction(
      req,
      conversationId,
      messageId,
      dto.emoji,
    );
  }

  /** Même opération, pour un client depuis l'application. */
  @Put(':messageId/reactions/client')
  @UseGuards(JwtCustomerAuthGuard)
  @ApiOperation({ summary: 'Réagir à un message (client)' })
  @ApiBody({ type: BasculerReactionDto })
  async basculerReactionClient(
    @Req() req: Request,
    @Param('conversationId') conversationId: string,
    @Param('messageId') messageId: string,
    @Body() dto: BasculerReactionDto,
  ) {
    return await this.messageService.basculerReaction(
      req,
      conversationId,
      messageId,
      dto.emoji,
    );
  }
}
