import {
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  Param,
  Patch,
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
import type { Request } from 'express';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Action } from 'src/modules/auth/enums/action.enum';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { JwtCustomerAuthGuard } from '../../auth/guards/jwt-customer-auth.guard';
import { CreateConversationDto } from '../dto/create-conversation.dto';
import { AjouterParticipantsDto, BasculerAlertesDto, RenommerGroupeDto } from '../dto/gerer-groupe.dto';
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

  // --- Staff : Statistiques des conversations ---
  @Get('stats')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.MESSAGES, Action.READ)
  @ApiOperation({ summary: 'Statistiques des conversations (staff uniquement)' })
  @ApiResponse({ status: 200, description: 'Retourne les stats de conversations' })
  async getConversationStats(@Req() req: Request) {
    return await this.conversationsService.getConversationStats(req);
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

  /**
   * GESTION D'UN GROUPE INTERNE : ajouter, retirer, quitter, renommer.
   *
   * ⚠️ Permission volontairement `MESSAGES.CREATE` et non UPDATE ou DELETE :
   * `Modules.MESSAGES` ne garde pas que la messagerie, il garde AUSSI les
   * catégories de tickets du support, où ces deux actions donneraient le
   * routage des tickets de tout le réseau. La règle fine (être membre, et être
   * responsable pour toucher aux autres) est appliquée dans le service, qui est
   * le seul endroit à connaître la composition du groupe.
   */
  @Post(':id/participants')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.MESSAGES, Action.CREATE)
  @ApiOperation({ summary: 'Ajouter des collègues à un groupe interne' })
  @ApiBody({ type: AjouterParticipantsDto })
  async ajouterParticipants(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: AjouterParticipantsDto,
  ) {
    return await this.conversationsService.ajouterParticipants(req, id, dto.user_ids);
  }

  /**
   * Retire une personne d'un groupe. Passer son PROPRE identifiant revient à
   * quitter le groupe, ce qui ne demande aucun rôle particulier : on n'est
   * jamais retenu dans une conversation.
   */
  @Delete(':id/participants/:userId')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.MESSAGES, Action.CREATE)
  @ApiOperation({ summary: 'Retirer une personne d\'un groupe, ou le quitter' })
  async retirerParticipant(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('userId') userId: string,
  ) {
    return await this.conversationsService.retirerParticipant(req, id, userId);
  }

  @Patch(':id/alerts')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.MESSAGES, Action.CREATE)
  @ApiOperation({ summary: 'Faire de ce groupe un canal d\'alertes du système' })
  @ApiBody({ type: BasculerAlertesDto })
  async basculerAlertes(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: BasculerAlertesDto,
  ) {
    return await this.conversationsService.basculerAlertes(req, id, dto.receives_alerts);
  }

  @Patch(':id/subject')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.MESSAGES, Action.CREATE)
  @ApiOperation({ summary: 'Renommer un groupe interne' })
  @ApiBody({ type: RenommerGroupeDto })
  async renommerGroupe(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: RenommerGroupeDto,
  ) {
    return await this.conversationsService.renommerGroupe(req, id, dto.subject);
  }
}
