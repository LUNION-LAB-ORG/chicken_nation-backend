import { Controller, Get, Post, Body, Param, Delete, Query, UseGuards, Req } from '@nestjs/common';
import { PaiementsService } from 'src/modules/paiements/services/paiements.service';
import { AddPaiementDto, CreatePaiementDto } from 'src/modules/paiements/dto/create-paiement.dto';
import { QueryPaiementDto } from 'src/modules/paiements/dto/query-paiement.dto';
import { CreatePaiementKkiapayDto } from '../dto/create-paiement-kkiapay.dto';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
// import { JwtCustomerAuthGuard } from 'src/modules/auth/guards/jwt-customer-auth.guard';
import { UserRoles } from 'src/modules/auth/decorators/user-roles.decorator';

import { UserRole } from '@prisma/client';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Request } from 'express';
import { UserPermissionsGuard } from 'src/common/guards/user-permissions.guard';
// import { RequirePermission } from 'src/common/decorators/user-require-permission';
// import { Modules } from 'src/common/enum/module-enum';
// import { Action } from 'src/common/enum/action.enum';

@ApiTags('Paiements')
@UseGuards(JwtAuthGuard, UserPermissionsGuard)
@Controller('paiements')
export class PaiementsController {
  constructor(private readonly paiementsService: PaiementsService) { }

  @ApiOperation({ summary: 'Payer via backoffice' })
  @Post('add')
  @UseGuards(JwtAuthGuard)
  addPaiement(@Req() req: Request, @Body() data: AddPaiementDto) {
    return this.paiementsService.addPaiement(req, data);
  }

  @ApiOperation({ summary: 'Payer avec Kkiapay' })
  @Post('pay')
  payWithKkiapay(@Req() req: Request, @Body() createPaiementKkiapayDto: CreatePaiementKkiapayDto) {
    return this.paiementsService.payWithKkiapay(req, createPaiementKkiapayDto);
  }

  @ApiOperation({ summary: 'Remboursement d\'un paiement par Kkiapay' })
  @UserRoles(UserRole.ADMIN, UserRole.MANAGER)
  @UseGuards(JwtAuthGuard)
  @Post('refund/:id')
  refundPaiement(@Param('id') paiementId: string) {
    return this.paiementsService.refundPaiement(paiementId);
  }

  @ApiOperation({ summary: 'Obtenir les paiements libres' })
  @Get('free')
  getFreePaiements(@Req() req: Request) {
    return this.paiementsService.getFreePaiements(req);
  }

  @ApiOperation({ summary: 'Créer un paiement' })
  @Post()
  create(@Body() createPaiementDto: CreatePaiementDto) {
    return this.paiementsService.create(createPaiementDto);
  }

  @ApiOperation({ summary: 'Lister tous les paiements' })
  @Get()
  findAll(@Query() queryDto: QueryPaiementDto) {
    return this.paiementsService.findAll(queryDto);
  }

  @ApiOperation({ summary: 'Obtenir un paiement par son ID' })
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.paiementsService.findOne(id);
  }

  @ApiOperation({ summary: 'Supprimer un paiement' })
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.paiementsService.remove(id);
  }
}
