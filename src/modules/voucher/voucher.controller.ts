import { QueryVoucherDto } from './dto/query-voucher.dto';
import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards, Req, Query } from '@nestjs/common';
import { VoucherService } from './voucher.service';
import { CreateVoucherDto } from './dto/create-voucher.dto';
import { UpdateVoucherDto } from './dto/update-voucher.dto';
import { RedeemVoucherDto } from './dto/redeem-voucher.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Request } from 'express';
import { JwtCustomerAuthGuard } from '../auth/guards/jwt-customer-auth.guard';
import { Customer } from '@prisma/client';

@Controller('voucher')
export class VoucherController {
  constructor(private readonly voucherService: VoucherService) { }

  @Post()
  @UseGuards(JwtAuthGuard)
  create(@Req() req: Request, @Body() createVoucherDto: CreateVoucherDto) {
    return this.voucherService.create(req, createVoucherDto);
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  findAll(@Query() query: QueryVoucherDto) {
    return this.voucherService.findAll(query);
  }

  @Get('client')
  @UseGuards(JwtCustomerAuthGuard)
  findAllForCustomer(@Req() req: Request, @Query() query: QueryVoucherDto) {
    const user = req.user as Customer;
    return this.voucherService.findAll({ ...query, customerId: user.id });
  }

  @Get('client/redemptions')
  @UseGuards(JwtCustomerAuthGuard)
  getCustomerRedemptions(@Req() req: Request) {
    const user = req.user as Customer;
    return this.voucherService.getCustomerRedemptions(user.id);
  }

  @Get(':code')
  @UseGuards(JwtAuthGuard)
  findOne(@Param('code') code: string) {
    return this.voucherService.findOne(code);
  }

  @Get(':code/redemptions')
  @UseGuards(JwtAuthGuard)
  getRedemptionHistory(@Param('code') code: string) {
    return this.voucherService.getRedemptionHistory(code);
  }

  @Patch(':code')
  @UseGuards(JwtAuthGuard)
  update(@Param('code') code: string, @Body() updateVoucherDto: UpdateVoucherDto) {
    return this.voucherService.update(code, updateVoucherDto);
  }

  @Post(':code/redeem')
  @UseGuards(JwtCustomerAuthGuard)
  redeemVoucher(
    @Param('code') code: string,
    @Req() req: Request,
    @Body() redeemDto: RedeemVoucherDto
  ) {
    const user = req.user as Customer;
    return this.voucherService.redeemVoucher(code, user.id, redeemDto);
  }

  @Post(':code/cancel')
  @UseGuards(JwtAuthGuard)
  cancel(@Param('code') code: string) {
    return this.voucherService.cancel(code);
  }

  @Delete(':code')
  @UseGuards(JwtAuthGuard)
  remove(@Param('code') code: string) {
    return this.voucherService.remove(code);
  }

  @Post(':code/restore')
  @UseGuards(JwtAuthGuard)
  restore(@Param('code') code: string) {
    return this.voucherService.restore(code);
  }
}