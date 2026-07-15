import { Body, Controller, Get, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { User } from '@prisma/client';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { Action } from 'src/modules/auth/enums/action.enum';
import { ReferralService } from './referral.service';
import { SetReferralConfigDto } from './dto/set-referral-config.dto';
import {
  EarningsHistoryQueryDto,
  MarkPaidDto,
  MarkPayableDto,
} from './dto/referral-earning-admin.dto';

/**
 * Parrainage — back office (staff). Réservé au module Fidélité : stats globales +
 * configuration (récompense parrain, bon de bienvenue, créateur système).
 */
@ApiTags('Referral Admin')
@Controller('referral/admin')
@UseGuards(JwtAuthGuard, UserPermissionsGuard)
export class ReferralAdminController {
  constructor(private readonly referralService: ReferralService) {}

  @Get('stats')
  @RequirePermission(Modules.FIDELITE, Action.READ)
  @ApiOperation({ summary: 'Stats globales de parrainage' })
  stats() {
    return this.referralService.getGlobalStats();
  }

  @Get('config')
  @RequirePermission(Modules.FIDELITE, Action.READ)
  @ApiOperation({ summary: 'Configuration courante du parrainage' })
  getConfig() {
    return this.referralService.getConfig();
  }

  @Put('config')
  @RequirePermission(Modules.FIDELITE, Action.UPDATE)
  @ApiOperation({ summary: 'Mettre à jour la configuration du parrainage' })
  setConfig(@Body() dto: SetReferralConfigDto) {
    return this.referralService.setConfig(dto);
  }

  // ── Versements ambassadeurs (volet monétaire, Phase 5) ─────────────────────

  @Get('ambassadors')
  @RequirePermission(Modules.FIDELITE, Action.READ)
  @ApiOperation({ summary: 'Ambassadeurs avec solde à verser (trié par solde décroissant)' })
  ambassadors() {
    return this.referralService.adminListAmbassadors();
  }

  @Get('earnings')
  @RequirePermission(Modules.FIDELITE, Action.READ)
  @ApiOperation({ summary: 'Historique paginé des gains (filtres : referrer_id, status)' })
  earnings(@Query() query: EarningsHistoryQueryDto) {
    return this.referralService.adminEarningsHistory(query);
  }

  @Post('earnings/mark-payable')
  @RequirePermission(Modules.FIDELITE, Action.UPDATE)
  @ApiOperation({ summary: 'Passer des gains PENDING→PAYABLE (manuel : ids ou parrain)' })
  markPayable(@Body() dto: MarkPayableDto) {
    return this.referralService.adminMarkPayable(dto);
  }

  @Post('earnings/apply-threshold')
  @RequirePermission(Modules.FIDELITE, Action.UPDATE)
  @ApiOperation({ summary: 'Rendre versables les gains des parrains au-dessus du seuil' })
  applyThreshold() {
    return this.referralService.adminApplyPayoutThreshold();
  }

  @Post('earnings/mark-paid')
  @RequirePermission(Modules.FIDELITE, Action.UPDATE)
  @ApiOperation({ summary: 'Marquer des gains PAYABLE→PAID (versement effectué)' })
  markPaid(@Req() req: Request, @Body() dto: MarkPaidDto) {
    const adminId = (req.user as User).id;
    return this.referralService.adminMarkPaid(dto, adminId);
  }
}
