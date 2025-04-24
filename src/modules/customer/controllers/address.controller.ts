import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards, Req } from '@nestjs/common';
import { AddressService } from 'src/modules/customer/services/address.service';
import { CreateAddressDto } from 'src/modules/customer/dto/create-address.dto';
import { UpdateAddressDto } from 'src/modules/customer/dto/update-address.dto';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserType } from '@prisma/client';
import { Request } from 'express';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { UserTypesGuard } from 'src/common/guards/user-types.guard';
import { UserTypes } from 'src/common/decorators/user-types.decorator';

@ApiTags('Addresses')
@ApiBearerAuth()
@Controller('addresses')
export class AddressController {
  constructor(private readonly addressService: AddressService) { }

  @ApiOperation({ summary: 'Création d\'une nouvelle adresse' })
  @Post()
  @UseGuards(JwtAuthGuard, UserTypesGuard)
  @UserTypes(UserType.CUSTOMER)
  create(@Req() req: Request, @Body() createAddressDto: CreateAddressDto) {
    return this.addressService.create(req, createAddressDto);
  }

  @ApiOperation({ summary: 'Récupération de toutes les adresses' })
  @Get()
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
  @UseGuards(JwtAuthGuard, UserTypesGuard)
  @UserTypes(UserType.CUSTOMER)
  update(@Req() req: Request, @Param('id') id: string, @Body() updateAddressDto: UpdateAddressDto) {
    return this.addressService.update(req, id, updateAddressDto);
  }

  @ApiOperation({ summary: 'Supprimer une adresse' })
  @Delete(':id')
  @UseGuards(JwtAuthGuard, UserTypesGuard)
  @UserTypes(UserType.CUSTOMER)
  remove(@Param('id') id: string) {
    return this.addressService.remove(id);
  }
}