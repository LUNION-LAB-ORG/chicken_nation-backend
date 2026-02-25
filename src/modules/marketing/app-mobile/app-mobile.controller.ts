import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Customer } from '@prisma/client';
import type { Request } from 'express';
import { JwtCustomerAuthGuard } from 'src/modules/auth/guards/jwt-customer-auth.guard';
import { AppMobileService } from './app-mobile.service';

@ApiTags('Marketing')
@Controller('marketing/app-mobile')
export class AppMobileController {

  constructor(
    private readonly appMobileService: AppMobileService,
  ) { }

  @Get('version')
  @ApiOperation({ summary: 'Récupère la configuration de version pour l\'application mobile' })
  getMobileVersion() {
    return this.appMobileService.getMobileVersion();
  }

  @Get('orders-to-comment')
  @UseGuards(JwtCustomerAuthGuard)
  @ApiOperation({ summary: 'Récupère les commandes à commenter' })
  getOrdersToComment(@Req() req: Request) {
    const customer = req.user as Customer;
    return this.appMobileService.getOrderToComment(customer.id);
  }
}
