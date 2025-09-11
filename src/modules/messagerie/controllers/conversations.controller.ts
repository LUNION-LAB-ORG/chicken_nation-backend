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
import { ModulePermissionsGuard } from 'src/common/guards/user-module-permissions-guard';
import { UserRoles } from 'src/common/decorators/user-roles.decorator';
import { RequirePermission } from 'src/common/decorators/user-require-permission';

@ApiTags('Conversations')
@ApiBearerAuth()
@UseGuards(ModulePermissionsGuard) // Vérification des permissions
@Controller('conversations')
export class ConversationsController {
  constructor(private readonly conversationsService: ConversationsService) {}

  @ApiOperation({
    summary: 'Lister toutes les conversations (staff uniquement)',
  })
  @ApiResponse({
    status: 200,
    description: 'Retourne les conversations avec pagination',
  })
  @UserRoles(UserRole.ADMIN, UserRole.CALL_CENTER)
  @RequirePermission('messages', 'read')
  @UseGuards(JwtAuthGuard)
  @Get()
  async getConversations(
    @Req() req: Request,
    @Query() filter: QueryConversationsDto,
  ) {
    return await this.conversationsService.getConversations(req, filter);
  }

  @ApiOperation({
    summary: 'Lister les conversations du client connecté',
  })
  @ApiResponse({
    status: 200,
    description: 'Retourne les conversations du client',
  })
  @UseGuards(JwtCustomerAuthGuard)
  @Get('/client')
  async getConversationsClient(
    @Req() req: Request,
    @Query() filter: QueryConversationsDto,
  ) {
    return await this.conversationsService.getConversations(req, filter);
  }

  @ApiOperation({
    summary: 'Créer une nouvelle conversation (staff)',
  })
  @ApiResponse({
    status: 201,
    description: 'Conversation créée avec message initial',
  })
  @ApiBody({ type: CreateConversationDto })
  @UserRoles(UserRole.ADMIN, UserRole.CALL_CENTER)
  @RequirePermission('messages', 'create')
  @UseGuards(JwtAuthGuard)
  @Post()
  async createConversation(
    @Req() req: Request,
    @Body() createConversationDto: CreateConversationDto,
  ) {
    return await this.conversationsService.createConversationWithInitialMessage(
      req,
      createConversationDto,
    );
  }

  @ApiOperation({
    summary: 'Créer une nouvelle conversation côté client',
  })
  @ApiResponse({
    status: 201,
    description: 'Conversation client créée avec message initial',
  })
  @UseGuards(JwtCustomerAuthGuard)
  @Post('/client')
  async createConversationClient(
    @Req() req: Request,
    @Body() createConversationDto: CreateConversationDto,
  ) {
    return await this.conversationsService.createConversationWithInitialMessage(
      req,
      createConversationDto,
    );
  }

  @ApiOperation({
    summary: 'Récupérer une conversation par ID (staff)',
  })
  @ApiResponse({
    status: 200,
    description: 'Retourne la conversation correspondante',
  })
  @UserRoles(UserRole.ADMIN, UserRole.CALL_CENTER)
  @RequirePermission('messages', 'read')
  @UseGuards(JwtAuthGuard)
  @Get(':id')
  async getConversationById(@Req() req: Request, @Param('id') id: string) {
    return await this.conversationsService.getConversationById(req, id);
  }
}
