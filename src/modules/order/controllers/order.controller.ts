import { Controller, Get, Post, Patch, Delete, Param, Body, Query, Req, Res, HttpStatus, HttpCode, UseGuards } from '@nestjs/common';
import { OrderService } from 'src/modules/order/services/order.service';
import { CreateOrderDto } from 'src/modules/order/dto/create-order.dto';
import { UpdateOrderDto } from 'src/modules/order/dto/update-order.dto';
import { QueryOrderDto } from 'src/modules/order/dto/query-order.dto';
import { OrderStatus, UserRole } from '@prisma/client';
import { ApiTags, ApiOperation, ApiResponse, ApiBody } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { JwtCustomerAuthGuard } from 'src/modules/auth/guards/jwt-customer-auth.guard';
import { ReceiptsService } from '../services/receipts.service';
import { UserPermissionsGuard } from 'src/common/guards/user-permissions.guard';
import { UserRoles } from 'src/common/decorators/user-roles.decorator';
import { RequirePermission } from 'src/common/decorators/user-require-permission';
import { Action } from 'src/common/enum/action.enum';
import { Modules } from 'src/common/enum/module-enum';

@ApiTags('Commandes')
@Controller('orders')
export class OrderController {
  constructor(
    private readonly orderService: OrderService,
    private readonly receiptsService: ReceiptsService,
  ) {}

  @Post()
  @UseGuards(JwtCustomerAuthGuard) // client peut créer ses propres commandes
  @UserRoles(UserRole.ADMIN, UserRole.MANAGER, UserRole.CAISSIER, UserRole.CALL_CENTER)
  @RequirePermission(Modules.COMMANDES, Action.CREATE)
  @ApiOperation({ summary: 'Créer une nouvelle commande' })
  @ApiResponse({ status: 201, description: 'Commande créée avec succès' })
  @ApiBody({ type: CreateOrderDto })
  async create(@Req() req: Request, @Body() createOrderDto: CreateOrderDto) {
    return this.orderService.create(req, createOrderDto);
  }

  @Get()
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @UserRoles(UserRole.ADMIN, UserRole.MANAGER, UserRole.CAISSIER, UserRole.CALL_CENTER, UserRole.COMPTABLE)
  @RequirePermission(Modules.COMMANDES, Action.READ)
  @ApiOperation({ summary: 'Rechercher toutes les commandes' })
  findAll(@Query() queryOrderDto: QueryOrderDto) {
    return this.orderService.findAll(queryOrderDto);
  }

  @Get('/customer')
  @UseGuards(JwtCustomerAuthGuard)
  @UserRoles(UserRole.CAISSIER, UserRole.CALL_CENTER)
  @RequirePermission(Modules.COMMANDES, Action.READ)
  @ApiOperation({ summary: 'Rechercher commandes d’un client' })
  findAllByCustomer(@Req() req: Request, @Query() queryOrderDto: QueryOrderDto) {
    return this.orderService.findAllByCustomer(req, queryOrderDto);
  }

  @Get('statistics')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @UserRoles(UserRole.ADMIN, UserRole.MANAGER, UserRole.COMPTABLE)
  @RequirePermission(Modules.DASHBOARD, Action.READ)
  @ApiOperation({ summary: 'Statistiques des commandes' })
  getOrderStatistics(@Query() queryOrderDto: QueryOrderDto) {
    return this.orderService.getOrderStatistics(queryOrderDto);
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @UserRoles(UserRole.ADMIN, UserRole.MANAGER, UserRole.CAISSIER, UserRole.CALL_CENTER, UserRole.COMPTABLE)
  @RequirePermission(Modules.COMMANDES, Action.READ)
  findOne(@Param('id') id: string) {
    return this.orderService.findById(id);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @UserRoles(UserRole.ADMIN, UserRole.CAISSIER, UserRole.CALL_CENTER)
  @RequirePermission(Modules.COMMANDES, Action.UPDATE)
  @ApiBody({ type: UpdateOrderDto })
  update(@Param('id') id: string, @Body() updateOrderDto: UpdateOrderDto) {
    return this.orderService.update(id, updateOrderDto);
  }

  @Patch(':id/status')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @UserRoles(UserRole.ADMIN, UserRole.CAISSIER, UserRole.CALL_CENTER)
  @RequirePermission(Modules.COMMANDES, Action.UPDATE)
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: Object.values(OrderStatus) },
        meta: { type: 'object', additionalProperties: true },
      },
      required: ['status'],
    },
  })
  updateStatus(@Param('id') id: string, @Body() body: { status: OrderStatus; meta?: Record<string, any> }) {
    return this.orderService.updateStatus(id, body.status, body.meta);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @UserRoles(UserRole.ADMIN)
  @RequirePermission(Modules.COMMANDES, Action.DELETE)
  @HttpCode(HttpStatus.OK)
  remove(@Param('id') id: string) {
    return this.orderService.remove(id);
  }

  @Get(':id/pdf')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @UserRoles(UserRole.ADMIN, UserRole.MANAGER)
  @RequirePermission(Modules.COMMANDES, Action.READ)
  async getReceiptPdf(@Param('id') id: string, @Res() res: Response) {
    await this.receiptsService.generateReceiptPdf(id, res);
  }
}
