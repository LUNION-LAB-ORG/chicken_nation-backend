import {
  Controller,
  Delete,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  Req,
  Res,
  HttpStatus,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CardRequestService } from '../services/card-request.service';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiConsumes,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { NationCardStatus } from '@prisma/client';
import { CardRequestQueryDto, NationCardQueryDto } from '../dtos/card-query.dto';
import { PreviewCardDto } from '../dtos/preview-card.dto';
import { RegenerateCardDto } from '../dtos/regenerate-card.dto';
import { ReviewCardRequestDto } from '../dtos/review-card-request.dto';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { Action } from 'src/modules/auth/enums/action.enum';


@ApiTags('Carte Nation - Administration')
@ApiBearerAuth()
@Controller('admin/card-nation')
@UseGuards(JwtAuthGuard, UserPermissionsGuard)
export class CardAdminController {
  constructor(private readonly cardRequestService: CardRequestService) { }

  /**
   * Liste de toutes les demandes de carte
   */
  @Get('requests')
  @RequirePermission(Modules.CARD_NATION, Action.READ)
  @ApiOperation({ summary: 'Récupérer toutes les demandes de carte' })
  async getAllRequests(@Query() query: CardRequestQueryDto) {
    return this.cardRequestService.getAllRequests(query);
  }

  /**
   * Détails d'une demande
   */
  @Get('requests/:id')
  @RequirePermission(Modules.CARD_NATION, Action.READ)
  @ApiOperation({ summary: 'Récupérer les détails d\'une demande' })
  async getRequestById(@Param('id') id: string) {
    return this.cardRequestService.getRequestById(id);
  }

  /**
   * Valider ou rejeter une demande
   */
  @Patch('requests/:id/review')
  @RequirePermission(Modules.CARD_NATION, Action.UPDATE)
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
   * Supprimer DÉFINITIVEMENT une demande (et sa carte si déjà générée)
   */
  @Delete('requests/:id')
  @RequirePermission(Modules.CARD_NATION, Action.DELETE)
  @ApiOperation({
    summary: 'Supprimer définitivement une demande de carte (et sa carte associée)',
  })
  async deleteRequest(@Param('id') id: string) {
    return this.cardRequestService.deleteRequest(id);
  }

  /**
   * Liste de toutes les cartes Nation
   */
  @Get('cards')
  @RequirePermission(Modules.CARD_NATION, Action.READ)
  @ApiOperation({ summary: 'Récupérer toutes les cartes Nation' })
  async getAllCards(@Query() query: NationCardQueryDto) {
    return this.cardRequestService.getAllCards(query);
  }

  /**
   * Détails d'une carte
   */
  @Get('cards/:id')
  @RequirePermission(Modules.CARD_NATION, Action.READ)
  @ApiOperation({ summary: 'Récupérer les détails d\'une carte' })
  async getCardById(@Param('id') id: string) {
    return this.cardRequestService.getCardById(id);
  }

  /**
   * Suspendre une carte
   */
  @Patch('cards/:id/suspend')
  @RequirePermission(Modules.CARD_NATION, Action.UPDATE)
  @ApiOperation({ summary: 'Suspendre une carte Nation' })
  async suspendCard(@Param('id') id: string) {
    return this.cardRequestService.updateCardStatus(id, NationCardStatus.SUSPENDED);
  }

  /**
   * Révoquer une carte
   */
  @Patch('cards/:id/revoke')
  @RequirePermission(Modules.CARD_NATION, Action.UPDATE)
  @ApiOperation({ summary: 'Révoquer une carte Nation' })
  async revokeCard(@Param('id') id: string) {
    return this.cardRequestService.updateCardStatus(id, NationCardStatus.REVOKED);
  }

  /**
   * Réactiver une carte
   */
  @Patch('cards/:id/activate')
  @RequirePermission(Modules.CARD_NATION, Action.UPDATE)
  @ApiOperation({ summary: 'Réactiver une carte Nation' })
  async activateCard(@Param('id') id: string) {
    return this.cardRequestService.updateCardStatus(id, NationCardStatus.ACTIVE);
  }

  /**
   * Régénérer le visuel d'une carte avec un type imposé par le staff.
   * Numéro et QR conservés ; seule l'image (+ niveau / marqueur étudiant) change.
   */
  @Patch('cards/:id/regenerate')
  @RequirePermission(Modules.CARD_NATION, Action.UPDATE)
  @ApiOperation({ summary: 'Régénérer une carte Nation avec un type choisi' })
  async regenerateCard(
    @Param('id') id: string,
    @Body() dto: RegenerateCardDto,
  ) {
    return this.cardRequestService.regenerateCard(id, dto.level, dto.is_student);
  }

  /**
   * Supprimer DÉFINITIVEMENT une carte (+ son image S3).
   * ⚠️ Irréversible — pour un retrait réversible, utiliser `revoke`.
   */
  @Delete('cards/:id')
  @RequirePermission(Modules.CARD_NATION, Action.DELETE)
  @ApiOperation({ summary: 'Supprimer définitivement une carte Nation (+ son image)' })
  async deleteCard(@Param('id') id: string) {
    return this.cardRequestService.deleteCard(id);
  }

  /**
   * Aperçu d'un design de carte (galerie des designs / testeur de génération).
   * Render-only : aucune écriture en base, aucun upload S3.
   */
  @Post('preview-card')
  @RequirePermission(Modules.CARD_NATION, Action.READ)
  @UseInterceptors(FileInterceptor('photo'))
  @ApiConsumes('multipart/form-data')
  @ApiOperation({
    summary: "Générer l'aperçu d'une carte (niveau + marqueur + photo de test)",
  })
  async previewCard(
    @Body() dto: PreviewCardDto,
    @UploadedFile() photo?: Express.Multer.File,
  ) {
    return this.cardRequestService.previewCard(dto, photo);
  }

  /**
   * Exporter la liste des cartes en Excel
   */
  @Get('cards/export/excel')
  @RequirePermission(Modules.CARD_NATION, Action.EXPORT)
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
  @RequirePermission(Modules.CARD_NATION, Action.REPORT)
  @ApiOperation({ summary: 'Récupérer les statistiques des cartes Nation' })
  async getStats() {
    // Cette méthode peut être ajoutée dans le service
    return {
      success: true,
      message: 'Statistiques à venir',
    };
  }
}