import {
  Body,
  Controller,
  Get,
  Logger,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Request } from 'express';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Action } from 'src/modules/auth/enums/action.enum';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { JwtCustomerAuthGuard } from '../../auth/guards/jwt-customer-auth.guard';
import { CreateConversationDto } from '../dto/create-conversation.dto';
import { QueryConversationsDto } from '../dto/query-conversations.dto';
import { ConversationsService } from '../services/conversations.service';

@ApiTags('Conversations')
@ApiBearerAuth()
@Controller('conversations')
export class ConversationsController {
  private readonly logger = new Logger(ConversationsController.name);
  constructor(private readonly conversationsService: ConversationsService) { }

  // --- Staff : Lister toutes les conversations ---
  @Get()
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.MESSAGES, Action.READ)
  @ApiOperation({ summary: 'Lister toutes les conversations (staff uniquement)' })
  @ApiResponse({ status: 200, description: 'Retourne les conversations avec pagination' })
  async getConversations(
    @Req() req: Request,
    @Query() filter: QueryConversationsDto,
  ) {
    return await this.conversationsService.getConversations(req, filter);
  }

  // --- Client : Lister ses propres conversations ---
  @Get('/client')
  @UseGuards(JwtCustomerAuthGuard)
  @ApiOperation({ summary: 'Lister les conversations du client connecté' })
  @ApiResponse({ status: 200, description: 'Retourne les conversations du client' })
  async getConversationsClient(
    @Req() req: Request,
    @Query() filter: QueryConversationsDto,
  ) {
    return await this.conversationsService.getConversations(req, filter);
  }

  // --- Staff : Créer une nouvelle conversation ---
  @Post()
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.MESSAGES, Action.CREATE)
  @ApiOperation({ summary: 'Créer une nouvelle conversation (staff)' })
  @ApiResponse({ status: 201, description: 'Conversation créée avec message initial' })
  @ApiBody({ type: CreateConversationDto })
  async createConversation(
    @Req() req: Request,
    @Body() createConversationDto: CreateConversationDto,
  ) {
    this.logger.log('Créer une conversation: ', createConversationDto);
    return await this.conversationsService.createConversationWithInitialMessage(
      req,
      createConversationDto,
    );
  }

  // --- Client : Créer une conversation côté client ---
  @Post('/client')
  @UseGuards(JwtCustomerAuthGuard)
  @ApiOperation({ summary: 'Créer une nouvelle conversation côté client' })
  @ApiResponse({ status: 201, description: 'Conversation client créée avec message initial' })
  async createConversationClient(
    @Req() req: Request,
    @Body() createConversationDto: CreateConversationDto,
  ) {

    this.logger.log('Créer une conversation client dto: ', createConversationDto);

    return await this.conversationsService.createConversationWithInitialMessage(
      req,
      createConversationDto,
    );
  }

  // --- Staff : Récupérer une conversation par ID ---
  @Get(':id')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.MESSAGES, Action.READ)
  @ApiOperation({ summary: 'Récupérer une conversation par ID (staff)' })
  @ApiResponse({ status: 200, description: 'Retourne la conversation correspondante' })
  async getConversationById(@Req() req: Request, @Param('id') id: string) {
    return await this.conversationsService.getConversationById(req, id);
  }
}
