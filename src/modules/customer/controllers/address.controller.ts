import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards, Req, UseInterceptors } from '@nestjs/common';
import { AddressService } from 'src/modules/customer/services/address.service';
import { CreateAddressDto } from 'src/modules/customer/dto/create-address.dto';
import { UpdateAddressDto } from 'src/modules/customer/dto/update-address.dto';
import { Request } from 'express';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtCustomerAuthGuard } from 'src/modules/auth/guards/jwt-customer-auth.guard';
import { CacheInterceptor } from '@nestjs/cache-manager';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { Action } from 'src/modules/auth/enums/action.enum';

@ApiTags('Addresses')
@ApiBearerAuth()
@Controller('addresses')
@UseInterceptors(CacheInterceptor)

export class AddressController {
  constructor(private readonly addressService: AddressService) { }

  @ApiOperation({ summary: 'Création d\'une nouvelle adresse' })
  @Post()
  @UseGuards(JwtCustomerAuthGuard)
  create(@Req() req: Request, @Body() createAddressDto: CreateAddressDto) {
    return this.addressService.create(req, createAddressDto);
  }

  @Get()
  @ApiOperation({ summary: 'Récupération de toutes les adresses' })
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.CLIENTS, Action.READ)
  findAll() {
    return this.addressService.findAll();
  }

  @ApiOperation({ summary: 'Obtenir une adresse par ID' })
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.addressService.findOne(id);
  }

  @ApiOperation({ summary: 'Obtenir toutes les adresses d un client' })
  @Get('customer/:customerId')
  findByCustomer(@Param('customerId') customerId: string) {
    return this.addressService.findByCustomer(customerId);
  }

  @ApiOperation({ summary: 'Mettre à jour une adresse' })
  @Patch(':id')
  @UseGuards(JwtCustomerAuthGuard)
  update(@Req() req: Request, @Param('id') id: string, @Body() updateAddressDto: UpdateAddressDto) {
    return this.addressService.update(req, id, updateAddressDto);
  }

  @ApiOperation({ summary: 'Supprimer une adresse' })
  @Delete(':id')
  @UseGuards(JwtCustomerAuthGuard)
  remove(@Param('id') id: string) {
    return this.addressService.remove(id);
  }
}