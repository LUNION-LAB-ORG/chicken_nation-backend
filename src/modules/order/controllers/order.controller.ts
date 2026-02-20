import { CacheInterceptor } from '@nestjs/cache-manager';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  UseInterceptors
} from '@nestjs/common';
import {
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags
} from '@nestjs/swagger';
import { Customer, OrderStatus, User } from '@prisma/client';
import { Request, Response } from 'express';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Action } from 'src/modules/auth/enums/action.enum';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { JwtCustomerAuthGuard } from 'src/modules/auth/guards/jwt-customer-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { CreateOrderDto } from 'src/modules/order/dto/create-order.dto';
import { QueryOrderCustomerDto, QueryOrderDto } from 'src/modules/order/dto/query-order.dto';
import { UpdateOrderDto } from 'src/modules/order/dto/update-order.dto';
import { OrderService } from 'src/modules/order/services/order.service';
import { FraisLivraisonDto } from '../dto/frais-livrasion.dto';
import { ReceiptsService } from '../services/receipts.service';
import { OrderCreateDto } from '../dto/order-create.dto';

@ApiTags('Commandes')
@Controller('orders')
@UseInterceptors(CacheInterceptor)
export class OrderController {
  constructor(
    private readonly orderService: OrderService,
    private readonly receiptsService: ReceiptsService,
  ) { }

  @Post()
  @UseGuards(JwtCustomerAuthGuard) // client peut créer ses propres commandes
  @ApiOperation({ summary: 'Créer une nouvelle commande' })
  @ApiResponse({ status: 201, description: 'Commande créée avec succès' })
  @ApiBody({ type: CreateOrderDto })
  async create(@Req() req: Request, @Body() createOrderDto: CreateOrderDto) {
    return this.orderService.create(req, createOrderDto);
  }
  @Post("/create-v2")
  @UseGuards(JwtCustomerAuthGuard)
  @ApiOperation({ summary: 'Créer une nouvelle commande' })
  @ApiResponse({ status: 201, description: 'Commande créée avec succès' })
  @ApiBody({ type: OrderCreateDto })
  async createorderv2(@Req() req: Request, @Body() createOrderDto: OrderCreateDto) {
    const customer_id = (req.user as Customer).id;
    return this.orderService.createv2(customer_id, createOrderDto);
  }


  @Post("/create")
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.COMMANDES, Action.CREATE)
  @ApiOperation({ summary: 'Créer une nouvelle commande' })
  @ApiResponse({ status: 201, description: 'Commande créée avec succès' })
  @ApiBody({ type: CreateOrderDto })
  async createBackoffice(@Req() req: Request, @Body() createOrderDto: CreateOrderDto) {
    return this.orderService.create(req, createOrderDto);
  }

  @Get()
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.COMMANDES, Action.READ)
  @ApiOperation({ summary: 'Rechercher toutes les commandes' })
  findAll(@Query() queryOrderDto: QueryOrderDto) {
    return this.orderService.findAll(queryOrderDto);
  }

  @Get('/customer')
  @UseGuards(JwtCustomerAuthGuard)
  @ApiOperation({ summary: 'Rechercher commandes d’un client' })
  findAllByCustomer(
    @Req() req: Request,
    @Query() queryOrderDto: QueryOrderCustomerDto,
  ) {
    return this.orderService.findAllByCustomer(req, queryOrderDto);
  }

  @Get('/statistics')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.DASHBOARD, Action.READ)
  @ApiOperation({ summary: 'Statistiques des commandes' })
  getOrderStatistics(@Query() queryOrderDto: QueryOrderDto) {
    return this.orderService.getOrderStatistics(queryOrderDto);
  }

  @Get('/export-report-to-excel')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.DASHBOARD, Action.EXPORT)
  @ApiOperation({ summary: 'Exporter un rapport des commandes' })
  @ApiResponse({ status: 200, description: 'Rapport des commandes exporté avec succès' })
  async exportOrderReportToExcel(@Query() query: QueryOrderDto, @Res() res: Response) {
    const { buffer, filename } = await this.orderService.exportOrderReportToExcel(query);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.byteLength);

    res.status(HttpStatus.OK).send(buffer);
  }

  @Get('/frais-livraison')
  @ApiOperation({ summary: 'Obtenir le prix des frais de livraison' })
  @ApiResponse({
    status: 200,
    description: 'Frais de livraison obtenus avec succès',
  })
  @ApiBody({ type: FraisLivraisonDto })
  async obtenirFraisLivraison(@Query() params: FraisLivraisonDto) {
    return this.orderService.obtenirFraisLivraison(params);
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.COMMANDES, Action.READ)
  findOne(@Param('id') id: string) {
    return this.orderService.findById(id);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.COMMANDES, Action.UPDATE)
  @ApiBody({ type: UpdateOrderDto })
  update(@Param('id') id: string, @Body() updateOrderDto: UpdateOrderDto) {
    return this.orderService.update(id, updateOrderDto);
  }

  @Patch(':id/status')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
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
  updateStatus(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() body: { status: OrderStatus; meta?: Record<string, any> },
  ) {
    const userId = (req.user as User).id;
    return this.orderService.updateStatus(id, body.status, { ...body.meta, userId });
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.COMMANDES, Action.DELETE)
  @HttpCode(HttpStatus.OK)
  remove(@Param('id') id: string) {
    return this.orderService.remove(id);
  }

  @Get(':id/pdf')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.COMMANDES, Action.EXPORT)
  async getReceiptPdf(@Param('id') id: string, @Res() res: Response) {
    await this.receiptsService.generateReceiptPdf(id, res);
  }

  @Get('export/restaurant-pdf')
  async exportRestaurantPdf(@Query() query: QueryOrderDto, @Res() res: Response) {
    const result = await this.orderService.exportRestaurantOrdersToPDF(query);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${result.filename}"`,
      'Content-Length': result.buffer.length,
    });

    res.send(result.buffer);
  }
}
