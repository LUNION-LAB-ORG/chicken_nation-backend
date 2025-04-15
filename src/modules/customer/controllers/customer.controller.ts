import { Controller, Query, Get, Post, Body, Patch, Param, Delete, Req, UseGuards } from '@nestjs/common';
import { CustomerService } from 'src/modules/customer/services/customer.service';
import { CreateCustomerDto } from 'src/modules/customer/dto/create-customer.dto';
import { UpdateCustomerDto } from 'src/modules/customer/dto/update-customer.dto';
import { Request } from 'express';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserTypesGuard } from 'src/common/guards/user-types.guard';
import { UserTypes } from 'src/common/decorators/user-types.decorator';
import { UserRole, UserType } from '@prisma/client';
import { UserRoles } from 'src/common/decorators/user-roles.decorator';
import { UserRolesGuard } from 'src/common/guards/user-roles.guard';
import { CustomerQueryDto } from 'src/modules/customer/dto/customer-query.dto';

@Controller('customer')
export class CustomerController {
  constructor(private readonly customerService: CustomerService) { }


  // CREATE CUSTOMER

  @Post()
  @UseGuards(JwtAuthGuard, UserRolesGuard, UserTypesGuard)
  @UserRoles(UserRole.ADMIN, UserRole.MANAGER)
  @UserTypes(UserType.BACKOFFICE, UserType.RESTAURANT)
  create(@Body() createCustomerDto: CreateCustomerDto) {
    return this.customerService.create(createCustomerDto);
  }

  @Get()
  @UseGuards(JwtAuthGuard, UserRolesGuard, UserTypesGuard)
  @UserRoles(UserRole.ADMIN, UserRole.MANAGER)
  @UserTypes(UserType.BACKOFFICE, UserType.RESTAURANT)
  findAll(@Query() query: CustomerQueryDto) {
    return this.customerService.findAll(query);
  }

  @UseGuards(JwtAuthGuard)
  @Get('/detail')
  detail(@Req() req: Request) {
    return this.customerService.detail(req);
  }


  @UserTypes(UserType.BACKOFFICE, UserType.RESTAURANT)
  @UseGuards(JwtAuthGuard, UserTypesGuard)
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.customerService.findOne(id);
  }

  @UseGuards(JwtAuthGuard)
  @Patch()
  update(@Req() req: Request, @Body() updateCustomerDto: UpdateCustomerDto) {
    return this.customerService.update(req, updateCustomerDto);
  }

  @Get('phone/:phone')
  findByPhone(@Param('phone') phone: string) {
    return this.customerService.findByPhone(phone);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, UserRolesGuard)
  @UserRoles(UserRole.ADMIN)
  remove(@Param('id') id: string) {
    return this.customerService.remove(id);
  }
}
