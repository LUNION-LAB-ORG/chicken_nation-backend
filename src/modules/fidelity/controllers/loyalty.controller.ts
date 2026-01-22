import { Controller, Get, Post, Body, Param, Query, UseGuards } from '@nestjs/common';
import { LoyaltyService } from '../services/loyalty.service';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AddLoyaltyPointDto } from '../dto/add-loyalty-point.dto';
import { LoyaltyQueryDto } from '../dto/loyalty-query.dto';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { Action } from 'src/modules/auth/enums/action.enum';
import { UpdateLoyaltyConfigDto } from '../dto/loyalty-config.dto';

@ApiTags('Loyalty')
@Controller('fidelity/loyalty')
export class LoyaltyController {
  constructor(private readonly loyaltyService: LoyaltyService) { }

  @Post('config')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.FIDELITE, Action.CREATE)
  @ApiOperation({ summary: 'Créer ou mettre à jour la configuration de fidélité' })
  @ApiOkResponse({
    description: 'Configuration de fidélité créée/mise à jour'
  })
  updateConfig(@Body() body: UpdateLoyaltyConfigDto) {
    return this.loyaltyService.updateConfig(body);
  }

  @Get('config')
  @ApiOperation({ summary: 'Obtenir la configuration de la fidélité' })
  @ApiOkResponse({
    description: 'Configuration de la fidélité obtenue'
  })
  getConfig() {
    return this.loyaltyService.getConfig();
  }

  @Get('points')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.FIDELITE, Action.READ)
  @ApiOperation({ summary: 'Obtenir les informations de fidélité' })
  @ApiOkResponse({
    description: 'Informations de fidélité obtenues'
  })
  getAllLoyaltyPoints(@Query() query: LoyaltyQueryDto) {
    return this.loyaltyService.getAllLoyaltyPoints(query);
  }

  @Get('customer/:customerId')
  @ApiOperation({ summary: 'Obtenir les informations de fidélité d\'un client' })
  @ApiOkResponse({
    description: 'Informations de fidélité d\'un client obtenues'
  })
  getCustomerLoyaltyInfo(@Param('customerId') customerId: string) {
    return this.loyaltyService.getCustomerLoyaltyInfo(customerId);
  }

  @Get('customer/:customerId/points/breakdown')
  @ApiOperation({ summary: 'Obtenir les points utilisables d\'un client' })
  @ApiOkResponse({
    description: 'Points utilisables d\'un client obtenus'
  })
  getAvailablePointsBreakdown(@Param('customerId') customerId: string) {
    return this.loyaltyService.getAvailablePointsBreakdown(customerId);
  }


  @Post('points/add')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.FIDELITE, Action.CREATE)
  @ApiOperation({ summary: 'Ajouter des points de fidélité' })
  @ApiOkResponse({
    description: 'Points de fidélité ajoutés'
  })
  addPoints(@Body() body: AddLoyaltyPointDto) {
    return this.loyaltyService.addPoints(body);
  }

  @Post('points/redeem')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.FIDELITE, Action.UPDATE)
  @ApiOperation({ summary: 'Utiliser des points de fidélité' })
  @ApiOkResponse({
    description: 'Points de fidélité utilisés'
  })
  redeemPoints(@Body() body: Omit<AddLoyaltyPointDto, 'type' | 'order_id'>) {
    return this.loyaltyService.redeemPoints(body);
  }

  @Get('points/calculate')
  @ApiOperation({ summary: 'Calculer les points de fidélité pour un montant' })
  @ApiOkResponse({
    description: 'Points de fidélité calculés'
  })
  calculatePoints(@Query('amount') amount: number) {
    return this.loyaltyService.calculatePointsForOrder(amount);
  }

  @Get('points/calculate-amount')
  @ApiOperation({ summary: 'Calculer les points de fidélité pour un montant' })
  @ApiOkResponse({
    description: 'Points de fidélité calculés'
  })
  calculateAmount(@Query('points') points: number) {
    return this.loyaltyService.calculateAmountForPoints(points);
  }

  @Post('points/expire')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.FIDELITE, Action.UPDATE)
  @ApiOperation({ summary: 'Expirer les points de fidélité' })
  @ApiOkResponse({
    description: 'Points de fidélité expirés'
  })
  expirePoints() {
    return this.loyaltyService.expirePoints();
  }
}