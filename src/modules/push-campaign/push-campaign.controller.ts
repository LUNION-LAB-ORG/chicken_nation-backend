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
import { PushCampaignService } from './push-campaign.service';
import { CreateCampaignDto, SegmentPreviewDto } from './dto/create-campaign.dto';
import { CampaignQueryDto, TemplateQueryDto } from './dto/campaign-query.dto';
import { CreateTemplateDto, UpdateTemplateDto } from './dto/create-template.dto';
import { CreateScheduledDto, UpdateScheduledDto } from './dto/create-scheduled.dto';
import { CreateSegmentDto, UpdateSegmentDto } from './dto/create-segment.dto';

@ApiTags('Push Campaigns')
@Controller('push-campaigns')
@UseGuards(JwtAuthGuard)
export class PushCampaignController {
  constructor(private readonly service: PushCampaignService) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // CAMPAIGNS
  // ═══════════════════════════════════════════════════════════════════════════

  @Post()
  @ApiOperation({ summary: 'Créer et envoyer une campagne push' })
  create(@Body() dto: CreateCampaignDto, @Req() req: Request) {
    const userId = (req.user as User).id;
    return this.service.create(dto, userId);
  }

  @Get()
  @ApiOperation({ summary: 'Lister les campagnes' })
  findAll(@Query() query: CampaignQueryDto) {
    return this.service.findAll(query);
  }

  @Get('stats')
  @ApiOperation({ summary: 'KPIs globaux des campagnes' })
  getStats() {
    return this.service.getStats();
  }

  @Get('segments')
  @ApiOperation({ summary: 'Liste des segments avec compteurs live' })
  getSegments() {
    return this.service.getSegments();
  }

  @Post('segments/preview')
  @ApiOperation({ summary: 'Preview du nombre de destinataires' })
  previewSegment(@Body() dto: SegmentPreviewDto) {
    return this.service.previewSegment(dto);
  }

  @Post('segments/custom')
  @ApiOperation({ summary: 'Créer un segment personnalisé' })
  createSegment(@Body() dto: CreateSegmentDto, @Req() req: Request) {
    const userId = (req.user as User).id;
    return this.service.createSegment(dto, userId);
  }

  @Get('segments/custom')
  @ApiOperation({ summary: 'Lister les segments personnalisés' })
  findAllSegmentsCustom() {
    return this.service.findAllSegmentsCustom();
  }

  @Get('segments/custom/:id')
  @ApiOperation({ summary: "Détail d'un segment personnalisé" })
  findOneSegment(@Param('id') id: string) {
    return this.service.findOneSegment(id);
  }

  @Patch('segments/custom/:id')
  @ApiOperation({ summary: 'Modifier un segment personnalisé' })
  updateSegment(@Param('id') id: string, @Body() dto: UpdateSegmentDto) {
    return this.service.updateSegment(id, dto);
  }

  @Delete('segments/custom/:id')
  @ApiOperation({ summary: 'Supprimer un segment personnalisé' })
  deleteSegment(@Param('id') id: string) {
    return this.service.deleteSegment(id);
  }

  @Get('users')
  @ApiOperation({ summary: 'Lister les abonnés push' })
  getUsers(@Query() query: { page?: string; limit?: string; search?: string }) {
    return this.service.getUsers(query);
  }

  @Get('users/:id')
  @ApiOperation({ summary: "Détail d'un abonné push" })
  getUserDetail(@Param('id') id: string) {
    return this.service.getUserDetail(id);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TEMPLATES
  // ═══════════════════════════════════════════════════════════════════════════

  @Post('templates')
  @ApiOperation({ summary: 'Créer un template push' })
  createTemplate(@Body() dto: CreateTemplateDto, @Req() req: Request) {
    const userId = (req.user as User).id;
    return this.service.createTemplate(dto, userId);
  }

  @Get('templates')
  @ApiOperation({ summary: 'Lister les templates' })
  findAllTemplates(@Query() query: TemplateQueryDto) {
    return this.service.findAllTemplates(query);
  }

  @Get('templates/:id')
  @ApiOperation({ summary: "Détail d'un template" })
  findOneTemplate(@Param('id') id: string) {
    return this.service.findOneTemplate(id);
  }

  @Patch('templates/:id')
  @ApiOperation({ summary: 'Modifier un template' })
  updateTemplate(@Param('id') id: string, @Body() dto: UpdateTemplateDto) {
    return this.service.updateTemplate(id, dto);
  }

  @Delete('templates/:id')
  @ApiOperation({ summary: 'Supprimer un template' })
  deleteTemplate(@Param('id') id: string) {
    return this.service.deleteTemplate(id);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SCHEDULED NOTIFICATIONS
  // ═══════════════════════════════════════════════════════════════════════════

  @Post('scheduled')
  @ApiOperation({ summary: 'Créer une notification planifiée' })
  createScheduled(@Body() dto: CreateScheduledDto, @Req() req: Request) {
    const userId = (req.user as User).id;
    return this.service.createScheduled(dto, userId);
  }

  @Get('scheduled')
  @ApiOperation({ summary: 'Lister les notifications planifiées' })
  findAllScheduled() {
    return this.service.findAllScheduled();
  }

  @Get('scheduled/:id')
  @ApiOperation({ summary: "Détail d'une notification planifiée" })
  findOneScheduled(@Param('id') id: string) {
    return this.service.findOneScheduled(id);
  }

  @Patch('scheduled/:id')
  @ApiOperation({ summary: 'Modifier une notification planifiée' })
  updateScheduled(@Param('id') id: string, @Body() dto: UpdateScheduledDto) {
    return this.service.updateScheduled(id, dto);
  }

  @Delete('scheduled/:id')
  @ApiOperation({ summary: 'Supprimer une notification planifiée' })
  deleteScheduled(@Param('id') id: string) {
    return this.service.deleteScheduled(id);
  }

  @Patch('scheduled/:id/toggle')
  @ApiOperation({ summary: 'Activer/désactiver une notification planifiée' })
  toggleScheduled(@Param('id') id: string) {
    return this.service.toggleScheduled(id);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CAMPAIGN BY ID (must be last to avoid catching named routes)
  // ═══════════════════════════════════════════════════════════════════════════

  @Get(':id')
  @ApiOperation({ summary: "Détail d'une campagne" })
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Annuler une campagne planifiée' })
  cancel(@Param('id') id: string) {
    return this.service.cancel(id);
  }
}
