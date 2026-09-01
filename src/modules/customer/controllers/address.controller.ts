import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards, Req, UseInterceptors } from '@nestjs/common';
import { AddressService } from 'src/modules/customer/services/address.service';
import { CreateAddressDto } from 'src/modules/customer/dto/create-address.dto';
import { UpdateAddressDto } from 'src/modules/customer/dto/update-address.dto';
import type { Request } from 'express';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtCustomerAuthGuard } from 'src/modules/auth/guards/jwt-customer-auth.guard';
import { Customer } from '@prisma/client';
import { CacheInterceptor } from '@nestjs/cache-manager';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { Action } from 'src/modules/auth/enums/action.enum';

@ApiTags('Addresses')
@ApiBearerAuth()
@Controller('addresses')
// @UseInterceptors(CacheInterceptor)

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
  // ⚠️ Route sans aucune garde, vérifiée joignable en production sans jeton.
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.CLIENTS, Action.READ)
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.addressService.findOne(id);
  }

  @ApiOperation({ summary: 'Obtenir toutes les adresses d un client' })
  /**
   * ⚠️ Garde CLIENT, pas personnel.
   *
   * La route n'avait aucune garde, et ma première correction a posé une garde
   * PERSONNELLE : or c'est l'application cliente qui l'appelle, avec son propre
   * jeton. Le carnet d'adresses serait revenu vide, en silence, et plus aucune
   * commande en livraison n'aurait été possible sans tout ressaisir.
   *
   * Le paramètre d'URL est conservé pour ne pas casser l'appel existant, mais
   * IGNORE : l'identité vient du jeton, ce qui ferme la fuite sans rien
   * casser.
   */
  @UseGuards(JwtCustomerAuthGuard)
  @Get('customer/:customerId')
  findByCustomer(@Req() req: Request, @Param('customerId') customerId: string) {
    return this.addressService.findByCustomer((req.user as Customer).id);
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
  remove(@Req() req: Request, @Param('id') id: string) {
    // L'identité vient du jeton : la suppression est conditionnée au
    // propriétaire dans la requête elle même.
    return this.addressService.remove(id, (req.user as Customer).id);
  }
}