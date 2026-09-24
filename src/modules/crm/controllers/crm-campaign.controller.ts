import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { User } from '@prisma/client';
import type { Request, Response } from 'express';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Action } from 'src/modules/auth/enums/action.enum';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import {
  CampaignReportQueryDto,
  CreateCrmCampaignDto,
  DistributeCrmDto,
  QueryCampaignsDto,
  UpdateCrmCampaignDto,
  UpdateCrmTeamDto,
} from '../dto/campaign.dto';
import { CrmAlertService } from '../services/crm-alert.service';
import { CrmCampaignStatsService } from '../services/crm-campaign-stats.service';
import { CrmCampaignService } from '../services/crm-campaign.service';
import { CrmReportService } from '../services/crm-report.service';

/**
 * Campagnes de conversion (cahier §6). Création, lancement et réglages :
 * direction (CREATE). Suspension, reprise, clôture, équipe et répartition :
 * direction ou pilote de la campagne, contrôlé par le service.
 */
@ApiTags('Contacts (campagnes)')
@ApiBearerAuth()
@Controller('crm/campaigns')
@UseGuards(JwtAuthGuard, UserPermissionsGuard)
export class CrmCampaignController {
  constructor(
    private readonly campagnes: CrmCampaignService,
    private readonly stats: CrmCampaignStatsService,
    private readonly rapports: CrmReportService,
    private readonly alertes: CrmAlertService,
  ) {}

  @Get()
  @RequirePermission(Modules.CRM, Action.READ)
  lister(@Req() req: Request, @Query() q: QueryCampaignsDto) {
    return this.campagnes.lister(req.user as User, q);
  }

  @Get('compare')
  @RequirePermission(Modules.CRM, Action.REPORT)
  @ApiOperation({ summary: 'Historique et comparatif des campagnes lancées' })
  comparer() {
    return this.stats.comparer();
  }

  @Post()
  @RequirePermission(Modules.CRM, Action.CREATE)
  creer(@Req() req: Request, @Body() dto: CreateCrmCampaignDto) {
    return this.campagnes.creer(req.user as User, dto);
  }

  @Get(':id')
  @RequirePermission(Modules.CRM, Action.READ)
  detail(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.campagnes.detail(req.user as User, id);
  }

  @Patch(':id')
  @RequirePermission(Modules.CRM, Action.CREATE)
  modifier(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCrmCampaignDto) {
    return this.campagnes.modifier(id, dto);
  }

  @Get(':id/stats')
  @RequirePermission(Modules.CRM, Action.READ)
  @ApiOperation({ summary: 'Tableau de bord de la campagne' })
  statistiques(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.campagnes.statistiques(req.user as User, id);
  }

  @Get(':id/report')
  @RequirePermission(Modules.CRM, Action.EXPORT)
  @ApiOperation({ summary: 'Rapport de campagne en Excel ou en PDF' })
  async rapport(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: CampaignReportQueryDto,
    @Res() res: Response,
  ) {
    await this.campagnes.detail(req.user as User, id);
    const fichier = await this.rapports.generer(req.user as User, id, q.format ?? 'xlsx');
    res.setHeader('Content-Type', fichier.type);
    res.setHeader('Content-Disposition', `attachment; filename="${fichier.nom}"`);
    res.send(fichier.contenu);
  }

  @Post(':id/launch')
  @RequirePermission(Modules.CRM, Action.CREATE)
  lancer(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.campagnes.lancer(req.user as User, id);
  }

  @Post(':id/suspend')
  @RequirePermission(Modules.CRM, Action.UPDATE)
  suspendre(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.campagnes.suspendre(req.user as User, id);
  }

  @Post(':id/resume')
  @RequirePermission(Modules.CRM, Action.UPDATE)
  reprendre(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.campagnes.reprendre(req.user as User, id);
  }

  @Post(':id/complete')
  @RequirePermission(Modules.CRM, Action.UPDATE)
  async terminer(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    const resultat = await this.campagnes.terminer(req.user as User, id);
    const indicateurs = (resultat.rapport as { indicateurs?: { conversions: number; cibles: number } }).indicateurs;
    if (indicateurs) await this.alertes.notifierFinCampagne(id, indicateurs);
    return { liberes: resultat.liberes };
  }

  @Post(':id/distribute')
  @RequirePermission(Modules.CRM, Action.UPDATE)
  @ApiOperation({ summary: "Répartir équitablement les contacts sans agent entre l'équipe" })
  distribuer(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() dto: DistributeCrmDto) {
    return this.campagnes.distribuer(req.user as User, id, dto);
  }

  @Patch(':id/team')
  @RequirePermission(Modules.CRM, Action.UPDATE)
  equipe(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCrmTeamDto) {
    return this.campagnes.modifierEquipe(req.user as User, id, dto);
  }
}
