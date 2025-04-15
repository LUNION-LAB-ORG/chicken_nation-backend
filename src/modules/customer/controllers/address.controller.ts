import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards, Req } from '@nestjs/common';
import { AddressService } from 'src/modules/customer/services/address.service';
import { CreateAddressDto } from 'src/modules/customer/dto/create-address.dto';
import { UpdateAddressDto } from 'src/modules/customer/dto/update-address.dto';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserRole } from '@prisma/client';
import { UserRolesGuard } from 'src/common/guards/user-roles.guard';
import { UserRoles } from 'src/common/decorators/user-roles.decorator';
import { Request } from 'express';

@Controller('addresses')
export class AddressController {
  constructor(private readonly addressService: AddressService) { }

  @Post()
  create(@Req() req: Request, @Body() createAddressDto: CreateAddressDto) {
    return this.addressService.create(req, createAddressDto);
  }

  @Get()
  @UseGuards(JwtAuthGuard, UserRolesGuard)
  @UserRoles(UserRole.ADMIN, UserRole.MANAGER)
  findAll() {
    return this.addressService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.addressService.findOne(id);
  }

  @Get('customer/:customerId')
  findByCustomer(@Param('customerId') customerId: string) {
    return this.addressService.findByCustomer(customerId);
  }

  @Patch(':id')
  update(@Req() req: Request, @Param('id') id: string, @Body() updateAddressDto: UpdateAddressDto) {
    return this.addressService.update(req, id, updateAddressDto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.addressService.remove(id);
  }
}