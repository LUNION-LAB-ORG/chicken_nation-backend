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
import { CrmAccessService } from '../services/crm-access.service';
import { CrmAnalyticsService } from '../services/crm-analytics.service';
import { CrmExportService } from '../services/crm-export.service';
import { CrmPublicsService } from '../services/crm-publics.service';
import { CrmVentesService } from '../services/crm-ventes.service';

/**
 * Tableaux de bord du CRM (cahier §5 et §7). Droit REPORT : direction,
 * marketing, call center et manager (en consultation). Filtres communs :
 * `from`, `to` (jours, UTC), `campaign_id`, `segments` (plusieurs publics
 * séparés par des virgules) ou l'ancien `segment`.
 *
 * Périmètre : chaque route passe par `CrmAccessService.filtresAnalyse`, qui
 * pose le restaurant d'un compte de point de vente (seules les fiches de son
 * restaurant comptent, `campaign_id` ignoré) à partir du compte connecté,
 * jamais de la requête.
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
    private readonly access: CrmAccessService,
  ) {}

  private filtres<T extends object>(req: Request, q: T) {
    return this.access.filtresAnalyse(req.user as User, q);
  }

  @Get('publics')
  @RequirePermission(Modules.CRM, Action.REPORT)
  @ApiOperation({ summary: 'Vue comparée des publics : devenir des entrés, activité, stocks, seconde commande' })
  comparer(@Req() req: Request, @Query() q: AnalyticsQueryDto) {
    return this.publics.comparer(this.filtres(req, q));
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
  ventes(@Req() req: Request, @Query() q: VentesQueryDto) {
    return this.ventesService.ventes(this.filtres(req, q));
  }

  @Get('overview')
  @RequirePermission(Modules.CRM, Action.REPORT)
  @ApiOperation({ summary: 'Population, entonnoir et chiffre d’affaires des conversions' })
  vueEnsemble(@Req() req: Request, @Query() q: AnalyticsQueryDto) {
    return this.analytics.vueEnsemble(this.filtres(req, q));
  }

  @Get('reasons')
  @RequirePermission(Modules.CRM, Action.REPORT)
  @ApiOperation({ summary: 'Pareto des raisons de non-achat' })
  raisons(@Req() req: Request, @Query() q: AnalyticsQueryDto) {
    return this.analytics.raisons(this.filtres(req, q));
  }

  @Get('cohorts')
  @RequirePermission(Modules.CRM, Action.REPORT)
  @ApiOperation({ summary: "Cohortes d'un public : par mois d'inscription, de décrochage ou de capture" })
  cohortes(@Req() req: Request, @Query() q: CohortesQueryDto) {
    return this.publics.cohortes(this.filtres(req, q));
  }

  @Get('coupons')
  @RequirePermission(Modules.CRM, Action.REPORT)
  coupons(@Req() req: Request, @Query() q: AnalyticsQueryDto) {
    return this.analytics.coupons(this.filtres(req, q));
  }

  @Get('quality')
  @RequirePermission(Modules.CRM, Action.REPORT)
  @ApiOperation({ summary: 'Résolution au premier appel, temps de traitement, rétention' })
  qualite(@Req() req: Request, @Query() q: AnalyticsQueryDto) {
    return this.analytics.qualite(this.filtres(req, q));
  }

  @Get('agents')
  @RequirePermission(Modules.CRM, Action.REPORT)
  agents(@Req() req: Request, @Query() q: AnalyticsQueryDto) {
    return this.analytics.agents(this.filtres(req, q));
  }

  @Get('trend')
  @RequirePermission(Modules.CRM, Action.REPORT)
  tendance(@Req() req: Request, @Query() q: AnalyticsQueryDto) {
    return this.analytics.tendance(this.filtres(req, q));
  }

  @Get('verbatims')
  @RequirePermission(Modules.CRM, Action.REPORT)
  verbatims(@Req() req: Request, @Query() q: VerbatimsQueryDto) {
    return this.analytics.verbatims(this.filtres(req, q));
  }
}
