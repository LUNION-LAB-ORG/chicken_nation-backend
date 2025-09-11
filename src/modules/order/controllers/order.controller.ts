import { Controller, Get, Post, Body, Patch, Param, Delete, Query, Req, HttpStatus, HttpCode, UseGuards, Res } from '@nestjs/common';
import { OrderService } from 'src/modules/order/services/order.service';
import { CreateOrderDto } from 'src/modules/order/dto/create-order.dto';
import { UpdateOrderDto } from 'src/modules/order/dto/update-order.dto';
import { QueryOrderDto } from 'src/modules/order/dto/query-order.dto';
import { OrderStatus, UserRole } from '@prisma/client';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiBody } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { JwtCustomerAuthGuard } from 'src/modules/auth/guards/jwt-customer-auth.guard';
import { ReceiptsService } from '../services/receipts.service';


import { UserRoles } from 'src/common/decorators/user-roles.decorator';
import { UserRolesGuard } from 'src/common/guards/user-roles.guard';
import { ModulePermissionsGuard } from 'src/common/guards/user-module-permissions-guard';
import { RequirePermission } from 'src/common/decorators/user-require-permission';


@ApiTags('Commandes')
@UseGuards(UserRolesGuard, ModulePermissionsGuard)
@Controller('orders')
export class OrderController {
  constructor(
    private readonly orderService: OrderService,
    private readonly receiptsService: ReceiptsService
  ) {}

  @Post()
  @UserRoles(UserRole.ADMIN, UserRole.MANAGER, UserRole.CAISSIER, UserRole.CALL_CENTER)
  @RequirePermission('commandes', 'create')
  @UseGuards(JwtCustomerAuthGuard)
  @ApiOperation({ summary: 'Créer une nouvelle commande' })
  @ApiResponse({ status: 201, description: 'Commande créée avec succès' })
  @ApiBody({ type: CreateOrderDto })
  async create(@Req() req: Request, @Body() createOrderDto: CreateOrderDto) {
    return this.orderService.create(req, createOrderDto);
  }

  @Get()
  @UserRoles(UserRole.ADMIN, UserRole.MANAGER, UserRole.CAISSIER, UserRole.CALL_CENTER, UserRole.COMPTABLE)
  @RequirePermission('commandes', 'read')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Rechercher toutes les commandes' })
  findAll(@Query() queryOrderDto: QueryOrderDto) {
    return this.orderService.findAll(queryOrderDto);
  }

  @Get("/customer")
  @UserRoles(UserRole.CAISSIER, UserRole.CALL_CENTER)
  @RequirePermission('commandes', 'read')
  @UseGuards(JwtCustomerAuthGuard)
  @ApiOperation({ summary: 'Rechercher commandes d’un client' })
  findAllByCustomer(@Req() req: Request, @Query() queryOrderDto: QueryOrderDto) {
    return this.orderService.findAllByCustomer(req, queryOrderDto);
  }

  @Get('statistics')
  @UserRoles(UserRole.ADMIN, UserRole.MANAGER, UserRole.COMPTABLE)
  @RequirePermission('dashboard', 'read')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Statistiques des commandes' })
  getOrderStatistics(@Query() queryOrderDto: QueryOrderDto) {
    return this.orderService.getOrderStatistics(queryOrderDto);
  }

  @Get(':id')
  @UserRoles(UserRole.ADMIN, UserRole.MANAGER, UserRole.CAISSIER, UserRole.CALL_CENTER, UserRole.COMPTABLE)
  @RequirePermission('commandes', 'read')
  findOne(@Param('id') id: string) {
    return this.orderService.findById(id);
  }

  @Patch(':id')
  @UserRoles(UserRole.ADMIN, UserRole.CAISSIER, UserRole.CALL_CENTER)
  @RequirePermission('commandes', 'update')
  @ApiBody({ type: UpdateOrderDto })
  update(@Param('id') id: string, @Body() updateOrderDto: UpdateOrderDto) {
    return this.orderService.update(id, updateOrderDto);
  }

  @Patch(':id/status')
  @UserRoles(UserRole.ADMIN, UserRole.CAISSIER, UserRole.CALL_CENTER)
  @RequirePermission('commandes', 'update')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: Object.values(OrderStatus) },
        meta: { type: 'object', additionalProperties: true }
      },
      required: ['status']
    }
  })
  updateStatus(@Param('id') id: string, @Body() body: { status: OrderStatus; meta?: Record<string, any> }) {
    return this.orderService.updateStatus(id, body.status, body.meta);
  }

  @Delete(':id')
  @UserRoles(UserRole.ADMIN)
  @RequirePermission('commandes', 'delete')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  remove(@Param('id') id: string) {
    return this.orderService.remove(id);
  }

  @Get(':id/pdf')
  @UserRoles(UserRole.ADMIN, UserRole.MANAGER)
  @RequirePermission('commandes', 'read')
  @UseGuards(JwtAuthGuard)
  async getReceiptPdf(@Param('id') id: string, @Res() res: Response) {
    await this.receiptsService.generateReceiptPdf(id, res);
  }
}
