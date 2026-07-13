import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { Action } from 'src/modules/auth/enums/action.enum';
import { ReferralService } from './referral.service';
import { SetReferralConfigDto } from './dto/set-referral-config.dto';

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
}
