import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Deliverer } from '@prisma/client';

import { CurrentDeliverer } from 'src/modules/auth-deliverer/decorators/current-deliverer.decorator';
import { JwtDelivererAuthGuard } from 'src/modules/auth-deliverer/guards/jwt-deliverer-auth.guard';

import { QueryDelivererHistoryDto } from '../dto/query-deliverer-history.dto';
import { OrderDelivererService } from '../services/order-deliverer.service';

/**
 * Endpoints livreur pour les commandes.
 * Protégés par JwtDelivererAuthGuard — scope strict : uniquement le livreur connecté.
 */
@ApiTags('Orders — Deliverer')
@Controller('orders/deliverer')
@UseGuards(JwtDelivererAuthGuard)
export class OrderDelivererController {
  constructor(private readonly orderDelivererService: OrderDelivererService) {}

  @ApiOperation({
    summary: 'Historique des courses du livreur connecté',
    description:
      'Retourne les commandes où le livreur est affecté. Par défaut filtre sur ' +
      'COMPLETED + CANCELLED. Supporte pagination et filtre par date.',
  })
  @Get('me/history')
  async getMyHistory(
    @CurrentDeliverer() deliverer: Deliverer,
    @Query() query: QueryDelivererHistoryDto,
  ) {
    return this.orderDelivererService.getHistory(deliverer.id, query);
  }
}
