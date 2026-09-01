import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { User } from '@prisma/client';
import type { Request } from 'express';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { Action } from 'src/modules/auth/enums/action.enum';
import { PushCampaignService } from './push-campaign.service';
import { CreateCampaignDto, SegmentPreviewDto } from './dto/create-campaign.dto';
import { CampaignQueryDto, TemplateQueryDto } from './dto/campaign-query.dto';
import { CreateTemplateDto, UpdateTemplateDto } from './dto/create-template.dto';
import { CreateScheduledDto, UpdateScheduledDto } from './dto/create-scheduled.dto';
import { CreateSegmentDto, UpdateSegmentDto } from './dto/create-segment.dto';

/**
 * ⚠️ Ce contrôleur n'avait AUCUNE garde de permission, seulement
 * `JwtAuthGuard`. Autrement dit, n'importe quel membre du personnel connecté,
 * caissier compris, pouvait pousser une notification à toute la base clients,
 * créer des campagnes et en consulter les statistiques.
 *
 * La permission retenue est `SETTINGS`, celle qui garde DEJA le menu
 * Notifications dans le backoffice. Ce choix ferme la porte sans retirer
 * l'accès à qui que ce soit aujourd'hui. `MARKETING` serait sémantiquement plus
 * juste : c'est un seul mot à changer ici, le jour où les rôles seront
 * réattribués.
 */
@ApiTags('Push Campaigns')
@Controller('push-campaigns')
@UseGuards(JwtAuthGuard, UserPermissionsGuard)
export class PushCampaignController {
  constructor(private readonly service: PushCampaignService) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // CAMPAIGNS
  // ═══════════════════════════════════════════════════════════════════════════

  @Post()
  @RequirePermission(Modules.SETTINGS, Action.CREATE)
  @ApiOperation({ summary: 'Créer et envoyer une campagne push' })
  create(@Body() dto: CreateCampaignDto, @Req() req: Request) {
    const userId = (req.user as User).id;
    return this.service.create(dto, userId);
  }

  @Get()
  @RequirePermission(Modules.SETTINGS, Action.READ)
  @ApiOperation({ summary: 'Lister les campagnes' })
  findAll(@Query() query: CampaignQueryDto) {
    return this.service.findAll(query);
  }

  @Get('stats')
  @RequirePermission(Modules.SETTINGS, Action.READ)
  @ApiOperation({ summary: 'KPIs globaux des campagnes' })
  getStats() {
    return this.service.getStats();
  }

  @Get('stats/chart')
  @RequirePermission(Modules.SETTINGS, Action.READ)
  @ApiOperation({ summary: 'Données pour les graphiques analytics (30 derniers jours)' })
  getStatsChart(@Query('days') days?: string) {
    return this.service.getStatsChart(parseInt(days ?? '30', 10));
  }

  @Get('variables')
  @RequirePermission(Modules.SETTINGS, Action.READ)
  @ApiOperation({ summary: 'Variables disponibles pour la personnalisation' })
  getVariables() {
    return PushCampaignService.AVAILABLE_VARIABLES;
  }

  @Get('segments')
  @RequirePermission(Modules.SETTINGS, Action.READ)
  @ApiOperation({ summary: 'Liste des segments avec compteurs live' })
  getSegments() {
    return this.service.getSegments();
  }

  @Post('segments/preview')
  @RequirePermission(Modules.SETTINGS, Action.CREATE)
  @ApiOperation({ summary: 'Preview du nombre de destinataires' })
  previewSegment(@Body() dto: SegmentPreviewDto) {
    return this.service.previewSegment(dto);
  }

  @Post('segments/preview-filters')
  @RequirePermission(Modules.SETTINGS, Action.CREATE)
  @ApiOperation({ summary: 'Preview du nombre de destinataires avec filtres custom' })
  previewSegmentFilters(@Body() dto: { filters: Record<string, any> }) {
    return this.service.previewCustomFilters(dto.filters);
  }

  @Post('segments/custom')
  @RequirePermission(Modules.SETTINGS, Action.CREATE)
  @ApiOperation({ summary: 'Créer un segment personnalisé' })
  createSegment(@Body() dto: CreateSegmentDto, @Req() req: Request) {
    const userId = (req.user as User).id;
    return this.service.createSegment(dto, userId);
  }

  @Get('segments/custom')
  @RequirePermission(Modules.SETTINGS, Action.READ)
  @ApiOperation({ summary: 'Lister les segments personnalisés' })
  findAllSegmentsCustom() {
    return this.service.findAllSegmentsCustom();
  }

  @Get('segments/custom/:id')
  @RequirePermission(Modules.SETTINGS, Action.READ)
  @ApiOperation({ summary: "Détail d'un segment personnalisé" })
  findOneSegment(@Param('id') id: string) {
    return this.service.findOneSegment(id);
  }

  @Patch('segments/custom/:id')
  @RequirePermission(Modules.SETTINGS, Action.UPDATE)
  @ApiOperation({ summary: 'Modifier un segment personnalisé' })
  updateSegment(@Param('id') id: string, @Body() dto: UpdateSegmentDto) {
    return this.service.updateSegment(id, dto);
  }

  @Delete('segments/custom/:id')
  @RequirePermission(Modules.SETTINGS, Action.DELETE)
  @ApiOperation({ summary: 'Supprimer un segment personnalisé' })
  deleteSegment(@Param('id') id: string) {
    return this.service.deleteSegment(id);
  }

  @Get('users')
  @RequirePermission(Modules.SETTINGS, Action.READ)
  @ApiOperation({ summary: 'Lister les abonnés push' })
  getUsers(@Query() query: { page?: string; limit?: string; search?: string }) {
    return this.service.getUsers(query);
  }

  @Get('users/:id')
  @RequirePermission(Modules.SETTINGS, Action.READ)
  @ApiOperation({ summary: "Détail d'un abonné push" })
  getUserDetail(@Param('id') id: string) {
    return this.service.getUserDetail(id);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TEMPLATES
  // ═══════════════════════════════════════════════════════════════════════════

  @Post('templates')
  @RequirePermission(Modules.SETTINGS, Action.CREATE)
  @ApiOperation({ summary: 'Créer un template push' })
  createTemplate(@Body() dto: CreateTemplateDto, @Req() req: Request) {
    const userId = (req.user as User).id;
    return this.service.createTemplate(dto, userId);
  }

  @Get('templates')
  @RequirePermission(Modules.SETTINGS, Action.READ)
  @ApiOperation({ summary: 'Lister les templates' })
  findAllTemplates(@Query() query: TemplateQueryDto) {
    return this.service.findAllTemplates(query);
  }

  @Get('templates/:id')
  @RequirePermission(Modules.SETTINGS, Action.READ)
  @ApiOperation({ summary: "Détail d'un template" })
  findOneTemplate(@Param('id') id: string) {
    return this.service.findOneTemplate(id);
  }

  @Patch('templates/:id')
  @RequirePermission(Modules.SETTINGS, Action.UPDATE)
  @ApiOperation({ summary: 'Modifier un template' })
  updateTemplate(@Param('id') id: string, @Body() dto: UpdateTemplateDto) {
    return this.service.updateTemplate(id, dto);
  }

  @Delete('templates/:id')
  @RequirePermission(Modules.SETTINGS, Action.DELETE)
  @ApiOperation({ summary: 'Supprimer un template' })
  deleteTemplate(@Param('id') id: string) {
    return this.service.deleteTemplate(id);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SCHEDULED NOTIFICATIONS
  // ═══════════════════════════════════════════════════════════════════════════

  @Post('scheduled')
  @RequirePermission(Modules.SETTINGS, Action.CREATE)
  @ApiOperation({ summary: 'Créer une notification planifiée' })
  createScheduled(@Body() dto: CreateScheduledDto, @Req() req: Request) {
    const userId = (req.user as User).id;
    return this.service.createScheduled(dto, userId);
  }

  @Post('scheduled/multi')
  @RequirePermission(Modules.SETTINGS, Action.CREATE)
  @ApiOperation({ summary: 'Créer des notifications planifiées sur plusieurs dates' })
  createScheduledMulti(
    @Body() dto: CreateScheduledDto & { schedule_dates: string[] },
    @Req() req: Request,
  ) {
    const userId = (req.user as User).id;
    return this.service.createScheduledMulti(dto, dto.schedule_dates, userId);
  }

  @Get('scheduled')
  @RequirePermission(Modules.SETTINGS, Action.READ)
  @ApiOperation({ summary: 'Lister les notifications planifiées' })
  findAllScheduled(@Query('channel') channel?: string) {
    return this.service.findAllScheduled(channel);
  }

  @Get('scheduled/:id')
  @RequirePermission(Modules.SETTINGS, Action.READ)
  @ApiOperation({ summary: "Détail d'une notification planifiée" })
  findOneScheduled(@Param('id') id: string) {
    return this.service.findOneScheduled(id);
  }

  @Patch('scheduled/:id')
  @RequirePermission(Modules.SETTINGS, Action.UPDATE)
  @ApiOperation({ summary: 'Modifier une notification planifiée' })
  updateScheduled(@Param('id') id: string, @Body() dto: UpdateScheduledDto) {
    return this.service.updateScheduled(id, dto);
  }

  @Delete('scheduled/:id')
  @RequirePermission(Modules.SETTINGS, Action.DELETE)
  @ApiOperation({ summary: 'Supprimer une notification planifiée' })
  deleteScheduled(@Param('id') id: string) {
    return this.service.deleteScheduled(id);
  }

  @Patch('scheduled/:id/toggle')
  @RequirePermission(Modules.SETTINGS, Action.UPDATE)
  @ApiOperation({ summary: 'Activer/désactiver une notification planifiée' })
  toggleScheduled(@Param('id') id: string) {
    return this.service.toggleScheduled(id);
  }

  @Patch('scheduled/:id/migrate')
  @RequirePermission(Modules.SETTINGS, Action.UPDATE)
  @ApiOperation({ summary: 'Migrer une notification OneSignal vers Expo Push' })
  migrateScheduled(@Param('id') id: string) {
    return this.service.migrateToExpoPush(id);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CAMPAIGN BY ID (must be last to avoid catching named routes)
  // ═══════════════════════════════════════════════════════════════════════════

  @Get(':id')
  @RequirePermission(Modules.SETTINGS, Action.READ)
  @ApiOperation({ summary: "Détail d'une campagne" })
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Delete(':id')
  @RequirePermission(Modules.SETTINGS, Action.DELETE)
  @ApiOperation({ summary: 'Annuler une campagne planifiée' })
  cancel(@Param('id') id: string) {
    return this.service.cancel(id);
  }
}
