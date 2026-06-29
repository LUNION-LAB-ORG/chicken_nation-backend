import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  HttpStatus,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { CustomerService } from 'src/modules/customer/services/customer.service';
import { CreateCustomerDto } from 'src/modules/customer/dto/create-customer.dto';
import { UpdateCustomerDto } from 'src/modules/customer/dto/update-customer.dto';
import { AdminUpdateCustomerDto } from 'src/modules/customer/dto/admin-update-customer.dto';
import type { Request, Response } from 'express';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { CustomerQueryDto } from 'src/modules/customer/dto/customer-query.dto';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtCustomerAuthGuard } from 'src/modules/auth/guards/jwt-customer-auth.guard';
import { CacheTTL, CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { UserScopedCacheInterceptor } from 'src/modules/order/interceptors/user-scoped-cache.interceptor';
import { RestaurantQueryScopeGuard } from 'src/common/guards/restaurant-query-scope.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { Action } from 'src/modules/auth/enums/action.enum';
import { NotificationSettingService } from '../services/notification-setting.service';
import { UpdateNotificationSettingDto } from '../dto/update-notification-setting.dto';
import { Customer } from '@prisma/client';

@ApiTags('Customers')
@ApiBearerAuth()
@Controller('customer')
@UseInterceptors(UserScopedCacheInterceptor)
export class CustomerController {
  constructor(private readonly customerService: CustomerService,
    private readonly notificationSettingService: NotificationSettingService,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
  ) { }

  // CREATE CUSTOMER
  @Post()
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.CLIENTS, Action.CREATE)
  @UseInterceptors(FileInterceptor('image'))
  @ApiOperation({ summary: "Création d'un nouveau client" })
  async create(
    @Body() createCustomerDto: CreateCustomerDto,
    @UploadedFile() image: Express.Multer.File,
  ) {
    return this.customerService.create(createCustomerDto, image);
  }

  @Get()
  @UseGuards(JwtAuthGuard, UserPermissionsGuard, RestaurantQueryScopeGuard)
  @RequirePermission(Modules.CLIENTS, Action.READ)
  @CacheTTL(5 * 60 * 1000)
  @ApiOperation({ summary: 'Récupération de tous les clients' })
  findAll(@Query() query: CustomerQueryDto) {
    return this.customerService.findAll(query);
  }

  // EXPORT EXCEL — déclaré AVANT @Get(':id') pour que la route statique gagne.
  @Get('export')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard, RestaurantQueryScopeGuard)
  @RequirePermission(Modules.CLIENTS, Action.READ)
  @ApiOperation({ summary: 'Exporter les clients (Excel) selon les filtres courants' })
  async exportCustomers(@Query() query: CustomerQueryDto, @Res() res: Response) {
    const { buffer, filename } =
      await this.customerService.exportCustomersToExcel(query);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.byteLength);
    res.status(HttpStatus.OK).send(buffer);
  }

  @Get('/detail')
  @UseGuards(JwtCustomerAuthGuard)
  @ApiOperation({ summary: 'Obtenir le détail d un client' })
  detail(@Req() req: Request) {
    return this.customerService.detail(req);
  }

  @Patch('notification-setting')
  @UseGuards(JwtCustomerAuthGuard)
  @ApiOperation({ summary: 'Mettre à jour les paramètres de notification' })
  updateNotificationSetting(@Req() req: Request, @Body() dto: UpdateNotificationSettingDto) {
    const id = (req.user as Customer).id;
    return this.notificationSettingService.update(id, dto);
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.CLIENTS, Action.READ)
  @CacheTTL(2 * 60 * 1000)
  @ApiOperation({ summary: 'Obtenir un client par ID' })
  findOne(@Param('id') id: string) {
    return this.customerService.findOne(id);
  }

  @Patch()
  @UseGuards(JwtCustomerAuthGuard)
  @UseInterceptors(FileInterceptor('image'))
  @ApiOperation({ summary: 'Mettre à jour un client' })
  async update(
    @Req() req: Request,
    @Body() updateCustomerDto: UpdateCustomerDto,
    @UploadedFile() image: Express.Multer.File,
  ) {
    return this.customerService.update(req, updateCustomerDto, image);
  }

  @Get('phone/:phone')
  @ApiOperation({ summary: 'Obtenir un client par numéro de téléphone' })
  findByPhone(@Param('phone') phone: string) {
    return this.customerService.findByPhone(phone);
  }

  @Delete(':id')
  @UseGuards(JwtCustomerAuthGuard)
  @ApiOperation({ summary: 'Supprimer un client (par le client lui-même)' })
  remove(@Param('id') id: string) {
    return this.customerService.remove(id);
  }

  @Patch('admin/:id')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.CLIENTS, Action.UPDATE)
  @ApiOperation({ summary: "Modifier les infos d'un client (admin uniquement)" })
  async adminUpdate(
    @Param('id') id: string,
    @Body() dto: AdminUpdateCustomerDto,
  ) {
    const result = await this.customerService.adminUpdate(id, dto);
    // Invalider le cache serveur du détail (GET /customer/:id, TTL 2 min) pour
    // que la modification soit visible immédiatement côté backoffice.
    await this.cacheManager.del(`/api/v1/customer/${id}`);
    return result;
  }

  @Delete('admin/:id')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.CLIENTS, Action.DELETE)
  @ApiOperation({ summary: 'Supprimer un client (admin uniquement)' })
  adminRemove(@Param('id') id: string) {
    return this.customerService.remove(id);
  }
}
