import { Controller, Get, Post, Body, Param, Query } from '@nestjs/common';
import { LoyaltyService } from '../services/loyalty.service';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AddLoyaltyPointDto } from '../dto/add-loyalty-point.dto';

@ApiTags('Loyalty')
@Controller('fidelity/loyalty')
export class LoyaltyController {
  constructor(private readonly loyaltyService: LoyaltyService) { }

  @ApiOperation({ summary: 'Obtenir la configuration de la fidélité' })
  @ApiOkResponse({
    description: 'Configuration de la fidélité obtenue'
  })
  @Get('config')
  getConfig() {
    return this.loyaltyService.getConfig();
  }

  @ApiOperation({ summary: 'Obtenir les informations de fidélité d\'un client' })
  @ApiOkResponse({
    description: 'Informations de fidélité d\'un client obtenues'
  })
  @Get('customer/:customerId')
  getCustomerLoyaltyInfo(@Param('customerId') customerId: string) {
    return this.loyaltyService.getCustomerLoyaltyInfo(customerId);
  }

  @ApiOperation({ summary: 'Obtenir les points utilisables d\'un client' })
  @ApiOkResponse({
    description: 'Points utilisables d\'un client obtenus'
  })
  @Get('customer/:customerId/points/breakdown')
  getAvailablePointsBreakdown(@Param('customerId') customerId: string) {
    return this.loyaltyService.getAvailablePointsBreakdown(customerId);
  }
  @ApiOperation({ summary: 'Ajouter des points de fidélité' })
  @ApiOkResponse({
    description: 'Points de fidélité ajoutés'
  })
  @Post('points/add')
  addPoints(@Body() body: AddLoyaltyPointDto) {
    return this.loyaltyService.addPoints(body);
  }

  @ApiOperation({ summary: 'Utiliser des points de fidélité' })
  @ApiOkResponse({
    description: 'Points de fidélité utilisés'
  })
  @Post('points/redeem')
  redeemPoints(@Body() body: Omit<AddLoyaltyPointDto, 'type' | 'order_id'>) {
    return this.loyaltyService.redeemPoints(body);
  }

  @ApiOperation({ summary: 'Calculer les points de fidélité pour un montant' })
  @ApiOkResponse({
    description: 'Points de fidélité calculés'
  })
  @Get('points/calculate')
  calculatePoints(@Query('amount') amount: number) {
    return this.loyaltyService.calculatePointsForOrder(amount);
  }

  @ApiOperation({ summary: 'Calculer les points de fidélité pour un montant' })
  @ApiOkResponse({
    description: 'Points de fidélité calculés'
  })
  @Get('points/calculate-amount')
  calculateAmount(@Query('points') points: number) {
    return this.loyaltyService.calculateAmountForPoints(points);
  }

  @ApiOperation({ summary: 'Expirer les points de fidélité' })
  @ApiOkResponse({
    description: 'Points de fidélité expirés'
  })
  @Post('points/expire')
  expirePoints() {
    return this.loyaltyService.expirePoints();
  }
}