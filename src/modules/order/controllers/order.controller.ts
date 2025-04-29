import { Controller, Get, Post, Body, Patch, Param, Delete, Query, Req, HttpStatus, HttpCode, UseGuards } from '@nestjs/common';
import { OrderService } from 'src/modules/order/services/order.service';
import { CreateOrderDto } from 'src/modules/order/dto/create-order.dto';
import { UpdateOrderDto } from 'src/modules/order/dto/update-order.dto';
import { QueryOrderDto } from 'src/modules/order/dto/query-order.dto';
import { OrderStatus } from '@prisma/client';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiBody } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';

@ApiTags('Commandes')
@Controller('orders')
export class OrderController {
  constructor(private readonly orderService: OrderService) { }

  @Post()
  @ApiOperation({ summary: 'Créer une nouvelle commande' })
  @ApiResponse({ status: 201, description: 'Commande créée avec succès' })
  @ApiBody({ type: CreateOrderDto })
  @UseGuards(JwtAuthGuard)
  async create(@Req() req: Request, @Body() createOrderDto: CreateOrderDto) {
    return this.orderService.create(req, createOrderDto);
  }

  @Get()
  @ApiOperation({ summary: 'Rechercher toutes les commandes avec options de filtrage' })
  @ApiResponse({ status: 200, description: 'Retourne les commandes avec métadonnées de pagination' })
  findAll(@Query() queryOrderDto: QueryOrderDto) {
    return this.orderService.findAll(queryOrderDto);
  }

  @Get('statistics')
  @ApiOperation({ summary: 'Obtenir les statistiques des commandes pour le tableau de bord' })
  @ApiResponse({ status: 200, description: 'Retourne les statistiques des commandes' })
  getOrderStatistics(@Query() queryOrderDto: QueryOrderDto) {
    return this.orderService.getOrderStatistics(queryOrderDto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Trouver une commande par son ID' })
  @ApiResponse({ status: 200, description: 'Retourne la commande' })
  @ApiResponse({ status: 404, description: 'Commande introuvable' })
  @ApiParam({ name: 'id', description: 'ID de la commande' })
  findOne(@Param('id') id: string) {
    return this.orderService.findById(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Mettre à jour une commande' })
  @ApiResponse({ status: 200, description: 'Commande mise à jour avec succès' })
  @ApiResponse({ status: 404, description: 'Commande introuvable' })
  @ApiResponse({ status: 409, description: 'Seules les commandes en attente peuvent être modifiées' })
  @ApiParam({ name: 'id', description: 'ID de la commande' })
  @ApiBody({ type: UpdateOrderDto })
  update(@Param('id') id: string, @Body() updateOrderDto: UpdateOrderDto) {
    return this.orderService.update(id, updateOrderDto);
  }

  @Patch(':id/status')
  @ApiOperation({ summary: 'Mettre à jour le statut d\'une commande' })
  @ApiResponse({ status: 200, description: 'Statut de la commande mis à jour avec succès' })
  @ApiResponse({ status: 404, description: 'Commande introuvable' })
  @ApiResponse({ status: 409, description: 'Transition de statut invalide' })
  @ApiParam({ name: 'id', description: 'ID de la commande' })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: Object.values(OrderStatus),
          description: 'Nouveau statut de la commande'
        },
        meta: {
          type: 'object',
          description: 'Métadonnées supplémentaires pour le changement de statut',
          additionalProperties: true
        }
      },
      required: ['status']
    }
  })
  updateStatus(
    @Param('id') id: string,
    @Body() body: { status: OrderStatus; meta?: any }
  ) {
    return this.orderService.updateStatus(id, body.status, body.meta);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Supprimer une commande (suppression douce)' })
  @ApiResponse({ status: 200, description: 'Commande supprimée avec succès' })
  @ApiResponse({ status: 404, description: 'Commande introuvable' })
  @ApiResponse({ status: 409, description: 'Seules les commandes en attente ou annulées peuvent être supprimées' })
  @ApiParam({ name: 'id', description: 'ID de la commande' })
  @HttpCode(HttpStatus.OK)
  remove(@Param('id') id: string) {
    return this.orderService.remove(id);
  }
}