import {
  Body,
  Controller,
  Get,
  Param,
  Post,
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

@ApiTags('Conversations')
@ApiBearerAuth()
@Controller('conversations')
export class ConversationsController {
  constructor(private readonly conversationsService: ConversationsService) {}

  @ApiOperation({
    summary: 'Rechercher toutes les commandes avec options de filtrage',
  })
  @ApiResponse({
    status: 200,
    description: 'Retourne les commandes avec métadonnées de pagination',
  })
  @UseGuards(JwtAuthGuard)
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
  @Post()
  @UseGuards(JwtAuthGuard)
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
  @Get(':id')
  @UseGuards(JwtAuthGuard)
  async getConversationById(@Req() req: Request, @Param('id') id: string) {
    return await this.conversationsService.getConversationById(req, id);
  }
}
