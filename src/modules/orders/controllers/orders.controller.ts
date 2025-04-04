import { Controller, Get, Post, Body, Param, Patch, UseGuards, Request } from '@nestjs/common';
import { OrdersService } from '../services/orders.service';
import { CreateOrderDto } from '../dto/create-order.dto';
import { UpdateOrderStatusDto } from '../dto/update-order-status.dto';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { Order } from '../entities/order.entity';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiParam, ApiBody } from '@nestjs/swagger';

@ApiTags('orders')
@ApiBearerAuth()
@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @ApiOperation({ summary: 'Récupérer toutes les commandes', description: 'Accessible uniquement aux administrateurs' })
  @ApiResponse({ status: 200, description: 'Liste des commandes récupérée avec succès', type: [Order] })
  @ApiResponse({ status: 401, description: 'Non autorisé - Authentification requise' })
  @ApiResponse({ status: 403, description: 'Accès interdit - Rôle administrateur requis' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Get()
  findAll(): Promise<Order[]> {
    return this.ordersService.findAll();
  }

  @ApiOperation({ summary: 'Récupérer les commandes de l\'utilisateur connecté' })
  @ApiResponse({ status: 200, description: 'Liste des commandes de l\'utilisateur récupérée avec succès', type: [Order] })
  @ApiResponse({ status: 401, description: 'Non autorisé - Authentification requise' })
  @UseGuards(JwtAuthGuard)
  @Get('my-orders')
  getUserOrders(@Request() req): Promise<Order[]> {
    return this.ordersService.getUserOrders(req.user.userId);
  }

  @ApiOperation({ summary: 'Récupérer les statistiques des commandes', description: 'Accessible uniquement aux administrateurs' })
  @ApiResponse({ status: 200, description: 'Statistiques récupérées avec succès' })
  @ApiResponse({ status: 401, description: 'Non autorisé - Authentification requise' })
  @ApiResponse({ status: 403, description: 'Accès interdit - Rôle administrateur requis' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Get('stats')
  getOrderStats(): Promise<any> {
    return this.ordersService.getOrderStats();
  }

  @ApiOperation({ summary: 'Récupérer l\'historique complet des commandes', description: 'Accessible uniquement aux administrateurs' })
  @ApiResponse({ status: 200, description: 'Historique récupéré avec succès' })
  @ApiResponse({ status: 401, description: 'Non autorisé - Authentification requise' })
  @ApiResponse({ status: 403, description: 'Accès interdit - Rôle administrateur requis' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Get('history')
  getOrderHistory(): Promise<any> {
    return this.ordersService.getOrderHistory();
  }

  @ApiOperation({ summary: 'Récupérer une commande spécifique par ID' })
  @ApiParam({ name: 'id', description: 'ID de la commande à récupérer' })
  @ApiResponse({ status: 200, description: 'Commande récupérée avec succès', type: Order })
  @ApiResponse({ status: 401, description: 'Non autorisé - Authentification requise' })
  @ApiResponse({ status: 404, description: 'Commande non trouvée' })
  @UseGuards(JwtAuthGuard)
  @Get(':id')
  findOne(@Param('id') id: string): Promise<Order> {
    return this.ordersService.findOne(id);
  }

  @ApiOperation({ summary: 'Créer une nouvelle commande' })
  @ApiBody({ type: CreateOrderDto, description: 'Données de la commande à créer' })
  @ApiResponse({ status: 201, description: 'Commande créée avec succès', type: Order })
  @ApiResponse({ status: 400, description: 'Données invalides' })
  @ApiResponse({ status: 401, description: 'Non autorisé - Authentification requise' })
  @ApiResponse({ status: 404, description: 'Article de menu non trouvé' })
  @UseGuards(JwtAuthGuard)
  @Post()
  create(@Request() req, @Body() createOrderDto: CreateOrderDto): Promise<Order> {
    return this.ordersService.create(req.user.userId, createOrderDto);
  }

  @ApiOperation({ summary: 'Mettre à jour le statut d\'une commande', description: 'Accessible uniquement aux administrateurs' })
  @ApiParam({ name: 'id', description: 'ID de la commande à mettre à jour' })
  @ApiBody({ type: UpdateOrderStatusDto, description: 'Nouveau statut de la commande' })
  @ApiResponse({ status: 200, description: 'Statut de la commande mis à jour avec succès', type: Order })
  @ApiResponse({ status: 400, description: 'Transition de statut invalide' })
  @ApiResponse({ status: 401, description: 'Non autorisé - Authentification requise' })
  @ApiResponse({ status: 403, description: 'Accès interdit - Rôle administrateur requis' })
  @ApiResponse({ status: 404, description: 'Commande non trouvée' })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @Patch(':id/status')
  updateStatus(
    @Param('id') id: string,
    @Body() updateOrderStatusDto: UpdateOrderStatusDto,
  ): Promise<Order> {
    return this.ordersService.updateStatus(id, updateOrderStatusDto);
  }

  @ApiOperation({ summary: 'Annuler une commande' })
  @ApiParam({ name: 'id', description: 'ID de la commande à annuler' })
  @ApiResponse({ status: 200, description: 'Commande annulée avec succès', type: Order })
  @ApiResponse({ status: 400, description: 'La commande ne peut pas être annulée' })
  @ApiResponse({ status: 401, description: 'Non autorisé - Authentification requise' })
  @ApiResponse({ status: 404, description: 'Commande non trouvée' })
  @UseGuards(JwtAuthGuard)
  @Patch(':id/cancel')
  async cancelOrder(@Param('id') id: string): Promise<Order> {
    return this.ordersService.cancel(id);
  }
}