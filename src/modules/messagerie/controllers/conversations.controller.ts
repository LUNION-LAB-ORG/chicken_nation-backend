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
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Request } from 'express';
import { QueryConversationsDto } from '../dto/query-conversations.dto';
import { CreateConversationDto } from '../dto/create-conversation.dto';
import { ConversationsService } from '../services/conversations.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { JwtCustomerAuthGuard } from '../../auth/guards/jwt-customer-auth.guard';
import { UserRole } from '@prisma/client';
import { UserPermissionsGuard } from 'src/common/guards/user-permissions.guard';
import { UserRoles } from 'src/common/decorators/user-roles.decorator';
import { RequirePermission } from 'src/common/decorators/user-require-permission';
import { Modules } from 'src/common/enum/module-enum';
import { Action } from 'src/common/enum/action.enum';

@ApiTags('Conversations')
@ApiBearerAuth()
@Controller('conversations')
export class ConversationsController {
  constructor(private readonly conversationsService: ConversationsService) {}

  // --- Staff : Lister toutes les conversations ---
  @Get()
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @UserRoles(UserRole.ADMIN, UserRole.CALL_CENTER)
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
  @UserRoles(UserRole.ADMIN, UserRole.CALL_CENTER)
  @RequirePermission(Modules.MESSAGES, Action.CREATE)
  @ApiOperation({ summary: 'Créer une nouvelle conversation (staff)' })
  @ApiResponse({ status: 201, description: 'Conversation créée avec message initial' })
  @ApiBody({ type: CreateConversationDto })
  async createConversation(
    @Req() req: Request,
    @Body() createConversationDto: CreateConversationDto,
  ) {
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
    return await this.conversationsService.createConversationWithInitialMessage(
      req,
      createConversationDto,
    );
  }

  // --- Staff : Récupérer une conversation par ID ---
  @Get(':id')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @UserRoles(UserRole.ADMIN, UserRole.CALL_CENTER)
  @RequirePermission(Modules.MESSAGES, Action.READ)
  @ApiOperation({ summary: 'Récupérer une conversation par ID (staff)' })
  @ApiResponse({ status: 200, description: 'Retourne la conversation correspondante' })
  async getConversationById(@Req() req: Request, @Param('id') id: string) {
    return await this.conversationsService.getConversationById(req, id);
  }
}
