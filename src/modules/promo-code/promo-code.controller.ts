import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  Req,
  Query,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Customer } from '@prisma/client';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { JwtCustomerAuthGuard } from '../auth/guards/jwt-customer-auth.guard';
import { UserPermissionsGuard } from '../auth/guards/user-permissions.guard';
import { RequirePermission } from '../auth/decorators/user-require-permission';
import { Modules } from '../auth/enums/module-enum';
import { Action } from '../auth/enums/action.enum';
import { PromoCodeService } from './promo-code.service';
import { CreatePromoCodeDto } from './dto/create-promo-code.dto';
import { UpdatePromoCodeDto } from './dto/update-promo-code.dto';
import { QueryPromoCodeDto } from './dto/query-promo-code.dto';
import { ApplyPromoCodeDto } from './dto/apply-promo-code.dto';
import { RecordUsageDto } from './dto/record-usage.dto';

@ApiTags('Codes Promo')
@Controller('promo-code')
export class PromoCodeController {
  constructor(private readonly promoCodeService: PromoCodeService) {}

  @Post()
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.PROMOTIONS, Action.CREATE)
  @ApiOperation({ summary: 'Créer un code promo' })
  create(@Req() req: Request, @Body() dto: CreatePromoCodeDto) {
    return this.promoCodeService.create(req, dto);
  }

  @Get()
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.PROMOTIONS, Action.READ)
  @ApiOperation({ summary: 'Récupérer tous les codes promo' })
  findAll(@Query() query: QueryPromoCodeDto) {
    return this.promoCodeService.findAll(query);
  }

  @Get('stats')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.PROMOTIONS, Action.READ)
  @ApiOperation({ summary: 'Statistiques des codes promo' })
  getStats() {
    return this.promoCodeService.getStats();
  }

  // ================================
  // ROUTES CLIENT (mobile)
  // ================================

  @Post('apply')
  @UseGuards(JwtCustomerAuthGuard)
  @ApiOperation({ summary: 'Appliquer un code promo (mobile)' })
  applyPromoCode(@Req() req: Request, @Body() dto: ApplyPromoCodeDto) {
    const customer = req.user as Customer;
    return this.promoCodeService.applyPromoCode(dto.code, customer.id, dto.order_amount);
  }

  @Get('validate/:code')
  @UseGuards(JwtCustomerAuthGuard)
  @ApiOperation({ summary: 'Valider un code promo par code (mobile)' })
  validateByCode(@Param('code') code: string) {
    return this.promoCodeService.findByCode(code);
  }

  @Get('client')
  @UseGuards(JwtCustomerAuthGuard)
  @ApiOperation({ summary: 'Codes promo actifs pour le client' })
  getActiveForCustomer(@Req() req: Request) {
    const customer = req.user as Customer;
    return this.promoCodeService.getActiveForCustomer(customer.id);
  }

  // ================================
  // ROUTES BACKOFFICE (staff)
  // ================================

  @Get(':id')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.PROMOTIONS, Action.READ)
  @ApiOperation({ summary: 'Récupérer un code promo par ID' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.promoCodeService.findOne(id);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.PROMOTIONS, Action.UPDATE)
  @ApiOperation({ summary: 'Mettre à jour un code promo' })
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePromoCodeDto) {
    return this.promoCodeService.update(id, dto);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.PROMOTIONS, Action.DELETE)
  @ApiOperation({ summary: 'Supprimer un code promo (soft delete)' })
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.promoCodeService.remove(id);
  }

  @Post(':id/toggle')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.PROMOTIONS, Action.UPDATE)
  @ApiOperation({ summary: 'Activer/désactiver un code promo' })
  toggleActive(@Param('id', ParseUUIDPipe) id: string) {
    return this.promoCodeService.toggleActive(id);
  }

  @Post(':id/record-usage')
  @UseGuards(JwtCustomerAuthGuard)
  @ApiOperation({ summary: "Enregistrer l'utilisation d'un code promo" })
  recordUsage(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
    @Body() dto: RecordUsageDto,
  ) {
    const customer = req.user as Customer;
    return this.promoCodeService.recordUsage(
      id,
      customer.id,
      dto.order_id ?? null,
      dto.discount_amount,
    );
  }
}
