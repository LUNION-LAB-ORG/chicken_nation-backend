import { Controller, Get, Post, Body, Patch, Param, Delete, Query, Req, HttpStatus, HttpCode, UseGuards } from '@nestjs/common';
import { OrderService } from 'src/modules/order/services/order.service';
import { CreateOrderDto } from 'src/modules/order/dto/create-order.dto';
import { UpdateOrderDto } from 'src/modules/order/dto/update-order.dto';
import { QueryOrderDto } from 'src/modules/order/dto/query-order.dto';
import { OrderStatus } from '@prisma/client';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiBody } from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { JwtCustomerAuthGuard } from 'src/modules/auth/guards/jwt-customer-auth.guard';

@ApiTags('Commandes')
@Controller('orders')
export class OrderController {
  constructor(private readonly orderService: OrderService) { }

  @Post()
  @ApiOperation({ summary: 'Créer une nouvelle commande' })
  @ApiResponse({ status: 201, description: 'Commande créée avec succès' })
  @ApiBody({ type: CreateOrderDto })
  @UseGuards(JwtCustomerAuthGuard)
  async create(@Req() req: Request, @Body() createOrderDto: CreateOrderDto) {
    return this.orderService.create(req, createOrderDto);
  }


  @ApiOperation({ summary: 'Rechercher toutes les commandes avec options de filtrage' })
  @ApiResponse({ status: 200, description: 'Retourne les commandes avec métadonnées de pagination' })
  @UseGuards(JwtAuthGuard)
  @Get()
  findAll(@Query() queryOrderDto: QueryOrderDto) {
    return this.orderService.findAll(queryOrderDto);
  }


  @ApiOperation({ summary: 'Rechercher toutes les commandes avec options de filtrage d\'un client' })
  @ApiResponse({ status: 200, description: 'Retourne les commandes avec métadonnées de pagination' })
  @Get("/customer")
  @UseGuards(JwtCustomerAuthGuard)
  findAllByCustomer(@Req() req: Request, @Query() queryOrderDto: QueryOrderDto) {
    return this.orderService.findAllByCustomer(req, queryOrderDto);
  }


  @ApiOperation({ summary: 'Obtenir les statistiques des commandes pour le tableau de bord' })
  @ApiResponse({ status: 200, description: 'Retourne les statistiques des commandes' })
  @UseGuards(JwtAuthGuard)
  @Get('statistics')
  getOrderStatistics(@Query() queryOrderDto: QueryOrderDto) {
    return this.orderService.getOrderStatistics(queryOrderDto);
  }

  @ApiOperation({ summary: 'Trouver une commande par son ID' })
  @ApiResponse({ status: 200, description: 'Retourne la commande' })
  @ApiResponse({ status: 404, description: 'Commande introuvable' })
  @ApiParam({ name: 'id', description: 'ID de la commande' })
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.orderService.findById(id);
  }


  @ApiOperation({ summary: 'Mettre à jour une commande' })
  @ApiResponse({ status: 200, description: 'Commande mise à jour avec succès' })
  @ApiResponse({ status: 404, description: 'Commande introuvable' })
  @ApiResponse({ status: 409, description: 'Seules les commandes en attente peuvent être modifiées' })
  @ApiParam({ name: 'id', description: 'ID de la commande' })
  @ApiBody({ type: UpdateOrderDto })
  @Patch(':id')
  update(@Param('id') id: string, @Body() updateOrderDto: UpdateOrderDto) {
    return this.orderService.update(id, updateOrderDto);
  }

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
  @Patch(':id/status')
  updateStatus(
    @Param('id') id: string,
    @Body() body: { status: OrderStatus; meta?: Record<string, any> }
  ) {
    return this.orderService.updateStatus(id, body.status, body.meta);
  }

  @ApiOperation({ summary: 'Supprimer une commande (suppression douce)' })
  @ApiResponse({ status: 200, description: 'Commande supprimée avec succès' })
  @ApiResponse({ status: 404, description: 'Commande introuvable' })
  @ApiResponse({ status: 409, description: 'Seules les commandes en attente ou annulées peuvent être supprimées' })
  @ApiParam({ name: 'id', description: 'ID de la commande' })
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.orderService.remove(id);
  }

  @Get("update-statut/:id")
  updateStatut(@Param('id') id: string) {
    return this.orderService.updateStatuts(id);
  }
}