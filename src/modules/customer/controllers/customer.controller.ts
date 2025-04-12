import { Controller, Get, Post, Body, Patch, Param, Delete, Req, UseGuards } from '@nestjs/common';
import { CustomerService } from 'src/modules/customer/services/customer.service';
import { CreateCustomerDto } from 'src/modules/customer/dto/create-customer.dto';
import { UpdateCustomerDto } from 'src/modules/customer/dto/update-customer.dto';
import { Request } from 'express';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserTypesGuard } from 'src/modules/auth/guards/user-types.guard';
import { UserTypes } from 'src/modules/auth/decorators/user-types.decorator';
import { UserType } from '@prisma/client';

@Controller('customer')
export class CustomerController {
  constructor(private readonly customerService: CustomerService) { }


  // @Post()
  // create(@Body() createCustomerDto: CreateCustomerDto) {
  //   return this.customerService.create(createCustomerDto);
  // }

  // @Get()
  // findAll() {
  //   return this.customerService.findAll();
  // }

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

  // @Delete(':id')
  // remove(@Param('id') id: string) {
  //   return this.customerService.remove(+id);
  // }
}
