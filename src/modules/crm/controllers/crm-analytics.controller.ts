import { Controller, Get, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { User } from '@prisma/client';
import type { Request, Response } from 'express';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Action } from 'src/modules/auth/enums/action.enum';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import {
  AnalyticsQueryDto,
  CohortesQueryDto,
  ExportAnalyticsQueryDto,
  VentesQueryDto,
  VerbatimsQueryDto,
} from '../dto/analytics.dto';
import { CrmAnalyticsService } from '../services/crm-analytics.service';
import { CrmExportService } from '../services/crm-export.service';
import { CrmPublicsService } from '../services/crm-publics.service';
import { CrmVentesService } from '../services/crm-ventes.service';

/**
 * Tableaux de bord du CRM (cahier §5 et §7). Droit REPORT : direction,
 * marketing et call center (en consultation). Filtres communs : `from`, `to`
 * (jours, UTC), `campaign_id`, `segments` (plusieurs publics séparés par des
 * virgules) ou l'ancien `segment`.
 */
@ApiTags('CRM (tableaux de bord)')
@ApiBearerAuth()
@Controller('crm/analytics')
@UseGuards(JwtAuthGuard, UserPermissionsGuard)
export class CrmAnalyticsController {
  constructor(
    private readonly analytics: CrmAnalyticsService,
    private readonly ventesService: CrmVentesService,
    private readonly publics: CrmPublicsService,
    private readonly exports: CrmExportService,
  ) {}

  @Get('publics')
  @RequirePermission(Modules.CRM, Action.REPORT)
  @ApiOperation({ summary: 'Vue comparée des publics : devenir des entrés, activité, stocks, seconde commande' })
  comparer(@Query() q: AnalyticsQueryDto) {
    return this.publics.comparer(q);
  }

  @Get('export')
  @RequirePermission(Modules.CRM, Action.EXPORT)
  @ApiOperation({ summary: 'Export Excel de la vue comparée des publics, avec les filtres de l’écran' })
  async exporter(@Req() req: Request, @Query() q: ExportAnalyticsQueryDto, @Res() res: Response) {
    const fichier = await this.exports.exporterPublics(req.user as User, q);
    res.setHeader('Content-Type', fichier.type);
    res.setHeader('Content-Disposition', `attachment; filename="${fichier.nom}"`);
    res.send(fichier.contenu);
  }

  @Get('sales')
  @RequirePermission(Modules.CRM, Action.REPORT)
  @ApiOperation({ summary: 'Ventes du registre par public et par mois, captures par restaurant' })
  ventes(@Query() q: VentesQueryDto) {
    return this.ventesService.ventes(q);
  }

  @Get('overview')
  @RequirePermission(Modules.CRM, Action.REPORT)
  @ApiOperation({ summary: 'Population, entonnoir et chiffre d’affaires des conversions' })
  vueEnsemble(@Query() q: AnalyticsQueryDto) {
    return this.analytics.vueEnsemble(q);
  }

  @Get('reasons')
  @RequirePermission(Modules.CRM, Action.REPORT)
  @ApiOperation({ summary: 'Pareto des raisons de non-achat' })
  raisons(@Query() q: AnalyticsQueryDto) {
    return this.analytics.raisons(q);
  }

  @Get('cohorts')
  @RequirePermission(Modules.CRM, Action.REPORT)
  @ApiOperation({ summary: "Cohortes d'un public : par mois d'inscription, de décrochage ou de capture" })
  cohortes(@Query() q: CohortesQueryDto) {
    return this.publics.cohortes(q);
  }

  @Get('coupons')
  @RequirePermission(Modules.CRM, Action.REPORT)
  coupons(@Query() q: AnalyticsQueryDto) {
    return this.analytics.coupons(q);
  }

  @Get('quality')
  @RequirePermission(Modules.CRM, Action.REPORT)
  @ApiOperation({ summary: 'Résolution au premier appel, temps de traitement, rétention' })
  qualite(@Query() q: AnalyticsQueryDto) {
    return this.analytics.qualite(q);
  }

  @Get('agents')
  @RequirePermission(Modules.CRM, Action.REPORT)
  agents(@Query() q: AnalyticsQueryDto) {
    return this.analytics.agents(q);
  }

  @Get('trend')
  @RequirePermission(Modules.CRM, Action.REPORT)
  tendance(@Query() q: AnalyticsQueryDto) {
    return this.analytics.tendance(q);
  }

  @Get('verbatims')
  @RequirePermission(Modules.CRM, Action.REPORT)
  verbatims(@Query() q: VerbatimsQueryDto) {
    return this.analytics.verbatims(q);
  }
}
