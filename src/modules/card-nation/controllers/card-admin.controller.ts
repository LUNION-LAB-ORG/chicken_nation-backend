import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Query,
  UseGuards,
  Req,
  Res,
  HttpStatus,
} from '@nestjs/common';
import { CardRequestService } from '../services/card-request.service';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { NationCardStatus } from '@prisma/client';
import { CardRequestQueryDto, NationCardQueryDto } from '../dtos/card-query.dto';
import { ReviewCardRequestDto } from '../dtos/review-card-request.dto';

@ApiTags('Carte Nation - Administration')
@ApiBearerAuth()
@Controller('admin/card-nation')
@UseGuards(JwtAuthGuard)
export class CardAdminController {
  constructor(private readonly cardRequestService: CardRequestService) { }

  /**
   * Liste de toutes les demandes de carte
   */
  @Get('requests')
  @ApiOperation({ summary: 'Récupérer toutes les demandes de carte' })
  async getAllRequests(@Query() query: CardRequestQueryDto) {
    return this.cardRequestService.getAllRequests(query);
  }

  /**
   * Détails d'une demande
   */
  @Get('requests/:id')
  @ApiOperation({ summary: 'Récupérer les détails d\'une demande' })
  async getRequestById(@Param('id') id: string) {
    return this.cardRequestService.getRequestById(id);
  }

  /**
   * Valider ou rejeter une demande
   */
  @Patch('requests/:id/review')
  @ApiOperation({ summary: 'Valider ou rejeter une demande de carte' })
  async reviewRequest(
    @Param('id') id: string,
    @Req() req: Request,
    @Body() reviewDto: ReviewCardRequestDto,
  ) {
    const userId = (req as any).user.id;
    return this.cardRequestService.reviewRequest(id, userId, reviewDto);
  }

  /**
   * Liste de toutes les cartes Nation
   */
  @Get('cards')
  @ApiOperation({ summary: 'Récupérer toutes les cartes Nation' })
  async getAllCards(@Query() query: NationCardQueryDto) {
    return this.cardRequestService.getAllCards(query);
  }

  /**
   * Détails d'une carte
   */
  @Get('cards/:id')
  @ApiOperation({ summary: 'Récupérer les détails d\'une carte' })
  async getCardById(@Param('id') id: string) {
    return this.cardRequestService.getCardById(id);
  }

  /**
   * Suspendre une carte
   */
  @Patch('cards/:id/suspend')
  @ApiOperation({ summary: 'Suspendre une carte Nation' })
  async suspendCard(@Param('id') id: string) {
    return this.cardRequestService.updateCardStatus(id, NationCardStatus.SUSPENDED);
  }

  /**
   * Révoquer une carte
   */
  @Patch('cards/:id/revoke')
  @ApiOperation({ summary: 'Révoquer une carte Nation' })
  async revokeCard(@Param('id') id: string) {
    return this.cardRequestService.updateCardStatus(id, NationCardStatus.REVOKED);
  }

  /**
   * Réactiver une carte
   */
  @Patch('cards/:id/activate')
  @ApiOperation({ summary: 'Réactiver une carte Nation' })
  async activateCard(@Param('id') id: string) {
    return this.cardRequestService.updateCardStatus(id, NationCardStatus.ACTIVE);
  }

  /**
   * Exporter la liste des cartes en Excel
   */
  @Get('cards/export/excel')
  @ApiOperation({ summary: 'Exporter la liste des cartes en Excel' })
  async exportCardsToExcel(@Query() query: NationCardQueryDto, @Res() res: Response) {
    const { buffer, filename } = await this.cardRequestService.exportCardsToExcel(query);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.byteLength);

    res.status(HttpStatus.OK).send(buffer);
  }

  /**
   * Statistiques des cartes
   */
  @Get('stats')
  @ApiOperation({ summary: 'Récupérer les statistiques des cartes Nation' })
  async getStats() {
    // Cette méthode peut être ajoutée dans le service
    return {
      success: true,
      message: 'Statistiques à venir',
    };
  }
}