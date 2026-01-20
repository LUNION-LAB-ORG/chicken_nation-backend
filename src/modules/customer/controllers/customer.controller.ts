import { Controller, Query, Get, Post, Body, Patch, Param, Delete, Req, UseGuards, UseInterceptors, UploadedFile } from '@nestjs/common';
import { CustomerService } from 'src/modules/customer/services/customer.service';
import { CreateCustomerDto } from 'src/modules/customer/dto/create-customer.dto';
import { UpdateCustomerDto } from 'src/modules/customer/dto/update-customer.dto';
import { Request } from 'express';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { CustomerQueryDto } from 'src/modules/customer/dto/customer-query.dto';
import { GenerateConfigService } from 'src/common/services/generate-config.service';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtCustomerAuthGuard } from 'src/modules/auth/guards/jwt-customer-auth.guard';
import { CacheInterceptor } from '@nestjs/cache-manager';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { Action } from 'src/modules/auth/enums/action.enum';

@ApiTags('Customers')
@ApiBearerAuth()
@Controller('customer')
@UseInterceptors(CacheInterceptor)
export class CustomerController {
  constructor(private readonly customerService: CustomerService) { }


  // CREATE CUSTOMER
  @Post()
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.CLIENTS, Action.CREATE)
  @UseInterceptors(FileInterceptor('image', { ...GenerateConfigService.generateConfigSingleImageUpload('./uploads/customer-avatar') }))
  @ApiOperation({ summary: 'Création d\'un nouveau client' })
  async create(@Body() createCustomerDto: CreateCustomerDto, @UploadedFile() image: Express.Multer.File) {
    return this.customerService.create(createCustomerDto, image);
  }

  @Get()
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.CLIENTS, Action.READ)
  @ApiOperation({ summary: 'Récupération de tous les clients' })
  findAll(@Query() query: CustomerQueryDto) {
    return this.customerService.findAll(query);
  }

  @Get('/detail')
  @UseGuards(JwtCustomerAuthGuard)
  @ApiOperation({ summary: 'Obtenir le détail d un client' })
  detail(@Req() req: Request) {
    return this.customerService.detail(req);
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.CLIENTS, Action.READ)
  @ApiOperation({ summary: 'Obtenir un client par ID' })
  findOne(@Param('id') id: string) {
    return this.customerService.findOne(id);
  }

  @Patch()
  @UseGuards(JwtCustomerAuthGuard)
  @UseInterceptors(FileInterceptor('image', { ...GenerateConfigService.generateConfigSingleImageUpload('./uploads/customer-avatar') }))
  @ApiOperation({ summary: 'Mettre à jour un client' })
  async update(@Req() req: Request, @Body() updateCustomerDto: UpdateCustomerDto, @UploadedFile() image: Express.Multer.File) {
    return this.customerService.update(req, updateCustomerDto, image);
  }

  @Get('phone/:phone')
  @ApiOperation({ summary: 'Obtenir un client par numéro de téléphone' })
  findByPhone(@Param('phone') phone: string) {
    return this.customerService.findByPhone(phone);
  }

  @Delete(':id')
  @UseGuards(JwtCustomerAuthGuard)
  @ApiOperation({ summary: 'Supprimer un client' })
  remove(@Param('id') id: string) {
    return this.customerService.remove(id);
  }
}
