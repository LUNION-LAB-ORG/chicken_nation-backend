import { Body, Controller, Get, Post, Req, Param } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Request } from 'express';
import { PrismaService } from '../../../database/services/prisma.service';
import { QueryConversationsDto } from '../dtos/query-conversations.dto';
import { CreateConversationDto } from '../dtos/create-conversation.dto';
import { ConversationsService } from '../services/conversations.service';

@ApiTags('Conversations')
@ApiBearerAuth()
@Controller('conversations')
export class ConversationsController {
  constructor(
    private readonly conversationsService: ConversationsService,
    private readonly prisma: PrismaService,
  ) {}

  //   Customer
  // - voit uniquement ses conversations : where.customerId = auth.customerId.
  // - ne voit pas les conversations internes (puisqu’elles n’ont pas de customerId).
  //
  //   User (employé)
  // - par défaut, voit les conv de son restaurant (restaurantId = auth.restaurantId).
  // - restreindre aux conv où il est participant (jointure sur ConversationUser).
  @ApiOperation({
    summary: 'Rechercher toutes les commandes avec options de filtrage',
  })
  @ApiResponse({
    status: 200,
    description: 'Retourne les commandes avec métadonnées de pagination',
  })
  // @UseGuards(JwtAuthGuard) TODO: activer le guard JWT pour sécuriser l'accès
  @Get()
  async getConversations(@Req() req: Request, filter: QueryConversationsDto) {
    return await this.conversationsService.getConversations(req, filter);
  }

  @ApiOperation({
    summary: 'Rechercher toutes les commandes avec options de filtrage',
  })
  @ApiResponse({
    status: 200,
    description: 'Retourne les commandes avec métadonnées de pagination',
  })
  @ApiBody({ type: CreateConversationDto })
  @Post() //@UseGuards(JwtAuthGuard)
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
    summary: 'Récupérer une conversation par son ID',
  })
  @ApiResponse({
    status: 200,
    description: 'Retourne la conversation correspondante',
  })
  @Get(':id') // @UseGuards(JwtAuthGuard)
  async getConversationById(@Req() req: Request, @Param('id') id: string) {
    return await this.conversationsService.getConversationById(req, id);
  }
}
