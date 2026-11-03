import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
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
import {
  ChangerCodeParrainDto,
  ChercherClientsQueryDto,
  CreerParrainDto,
  ListeParrainsQueryDto,
  RattacherFilleulDto,
  VerserParrainDto,
} from './dto/referral-parrain-admin.dto';

/**
 * Parrainage — back office (staff). Réservé au module Fidélité : stats globales,
 * configuration, et gestion des parrains (liste, fiche, code, filleuls, versements).
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
  @ApiOperation({ summary: 'Tous les parrains (les plus de filleuls en tête), recherche et pages' })
  ambassadors(@Req() req: Request, @Query() query: ListeParrainsQueryDto) {
    return this.referralService.adminListAmbassadors(query, (req.user as User)?.role);
  }

  @Post('ambassadors')
  @RequirePermission(Modules.FIDELITE, Action.UPDATE)
  @ApiOperation({ summary: 'Faire d’un client un parrain (code choisi, sinon CN-PRENOM)' })
  creerParrain(@Body() dto: CreerParrainDto) {
    return this.referralService.adminCreerParrain(dto);
  }

  @Get('clients')
  @RequirePermission(Modules.FIDELITE, Action.UPDATE)
  @ApiOperation({ summary: 'Clients à faire parrain ou filleul, avec ce qui l’empêcherait' })
  chercherClients(@Req() req: Request, @Query() query: ChercherClientsQueryDto) {
    return this.referralService.adminChercherClients(query.search, (req.user as User)?.role);
  }

  @Get('ambassadors/:customerId')
  @RequirePermission(Modules.FIDELITE, Action.READ)
  @ApiOperation({ summary: 'Fiche d’un parrain : filleuls, gains, versements' })
  ambassador(@Param('customerId', ParseUUIDPipe) customerId: string) {
    return this.referralService.adminAmbassadorDetail(customerId);
  }

  @Patch('ambassadors/:customerId/code')
  @RequirePermission(Modules.FIDELITE, Action.UPDATE)
  @ApiOperation({ summary: 'Changer le code d’un parrain' })
  changerCode(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body() dto: ChangerCodeParrainDto,
  ) {
    return this.referralService.adminChangerCode(customerId, dto.code);
  }

  @Post('ambassadors/:customerId/filleuls')
  @RequirePermission(Modules.FIDELITE, Action.UPDATE)
  @ApiOperation({ summary: 'Rattacher un filleul qui a oublié le code' })
  rattacherFilleul(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body() dto: RattacherFilleulDto,
  ) {
    return this.referralService.adminRattacherFilleul(customerId, dto.customer_id);
  }

  @Post('ambassadors/:customerId/mark-payable')
  @RequirePermission(Modules.FIDELITE, Action.UPDATE)
  @ApiOperation({ summary: 'Passer en payable les gains en attente du parrain' })
  passerPayable(@Param('customerId', ParseUUIDPipe) customerId: string) {
    return this.referralService.adminPasserPayable(customerId);
  }

  @Post('ambassadors/:customerId/pay')
  @RequirePermission(Modules.FIDELITE, Action.UPDATE)
  @ApiOperation({ summary: 'Marquer payé tout le solde payable du parrain' })
  verser(
    @Req() req: Request,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body() dto: VerserParrainDto,
  ) {
    return this.referralService.adminVerser(customerId, dto, (req.user as User).id);
  }

  @Post('referrals/:referralId/annuler')
  @RequirePermission(Modules.FIDELITE, Action.UPDATE)
  @ApiOperation({ summary: 'Annuler un parrainage (gains non versés annulés)' })
  annulerParrainage(@Param('referralId', ParseUUIDPipe) referralId: string) {
    return this.referralService.adminAnnulerParrainage(referralId);
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
