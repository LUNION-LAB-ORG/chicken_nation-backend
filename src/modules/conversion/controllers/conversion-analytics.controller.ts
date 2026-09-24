import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Action } from 'src/modules/auth/enums/action.enum';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { AnalyticsQueryDto, VerbatimsQueryDto } from '../dto/analytics.dto';
import { ConversionAnalyticsService } from '../services/conversion-analytics.service';

/**
 * Tableaux de bord du module Prospects (cahier §5 et §7). Droit REPORT : la
 * direction et la lecture seule y ont accès ; un agent, lui, suit ses
 * chiffres du jour dans sa file.
 */
@ApiTags('Prospects (tableaux de bord)')
@ApiBearerAuth()
@Controller('conversion/analytics')
@UseGuards(JwtAuthGuard, UserPermissionsGuard)
export class ConversionAnalyticsController {
  constructor(private readonly analytics: ConversionAnalyticsService) {}

  @Get('overview')
  @RequirePermission(Modules.PROSPECTS, Action.REPORT)
  @ApiOperation({ summary: 'Population, entonnoir et chiffre d’affaires des conversions' })
  vueEnsemble(@Query() q: AnalyticsQueryDto) {
    return this.analytics.vueEnsemble(q);
  }

  @Get('reasons')
  @RequirePermission(Modules.PROSPECTS, Action.REPORT)
  @ApiOperation({ summary: 'Pareto des raisons de non-achat' })
  raisons(@Query() q: AnalyticsQueryDto) {
    return this.analytics.raisons(q);
  }

  @Get('cohorts')
  @RequirePermission(Modules.PROSPECTS, Action.REPORT)
  @ApiOperation({ summary: "Cohortes par mois d'inscription : conversion et délai" })
  cohortes() {
    return this.analytics.cohortes();
  }

  @Get('coupons')
  @RequirePermission(Modules.PROSPECTS, Action.REPORT)
  coupons(@Query() q: AnalyticsQueryDto) {
    return this.analytics.coupons(q);
  }

  @Get('quality')
  @RequirePermission(Modules.PROSPECTS, Action.REPORT)
  @ApiOperation({ summary: 'Résolution au premier appel, temps de traitement, rétention' })
  qualite(@Query() q: AnalyticsQueryDto) {
    return this.analytics.qualite(q);
  }

  @Get('agents')
  @RequirePermission(Modules.PROSPECTS, Action.REPORT)
  agents(@Query() q: AnalyticsQueryDto) {
    return this.analytics.agents(q);
  }

  @Get('trend')
  @RequirePermission(Modules.PROSPECTS, Action.REPORT)
  tendance(@Query() q: AnalyticsQueryDto) {
    return this.analytics.tendance(q);
  }

  @Get('verbatims')
  @RequirePermission(Modules.PROSPECTS, Action.REPORT)
  verbatims(@Query() q: VerbatimsQueryDto) {
    return this.analytics.verbatims(q);
  }
}
