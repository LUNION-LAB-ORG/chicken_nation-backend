import { Controller, Get, Post, Body, Param, Delete, Query, UseGuards, Req } from '@nestjs/common';
import { PaiementsService } from 'src/modules/paiements/services/paiements.service';
import { CreatePaiementDto } from 'src/modules/paiements/dto/create-paiement.dto';
import { QueryPaiementDto } from 'src/modules/paiements/dto/query-paiement.dto';
import { CreatePaiementKkiapayDto } from '../dto/create-paiement-kkiapay.dto';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { JwtCustomerAuthGuard } from 'src/modules/auth/guards/jwt-customer-auth.guard';
import { UserRoles } from 'src/common/decorators/user-roles.decorator';

import { UserRole } from '@prisma/client';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Request } from 'express';
import { UserPermissionsGuard } from 'src/common/guards/user-permissions.guard';
import { RequirePermission } from 'src/common/decorators/user-require-permission';
import { Modules } from 'src/common/enum/module-enum';
import { Action } from 'src/common/enum/action.enum';

@ApiTags('Paiements')
@UseGuards(JwtAuthGuard, UserPermissionsGuard)
@Controller('paiements')
export class PaiementsController {
  constructor(private readonly paiementsService: PaiementsService) {}

  @ApiOperation({ summary: 'Payer avec Kkiapay' })
  @UseGuards(JwtCustomerAuthGuard)
  @RequirePermission(Modules.COMMANDES, Action.CREATE) // Caissier et Customer peuvent créer un paiement
  @UserRoles(UserRole.CAISSIER)
  @Post('pay')
  payWithKkiapay(@Req() req: Request, @Body() createPaiementKkiapayDto: CreatePaiementKkiapayDto) {
    return this.paiementsService.payWithKkiapay(req, createPaiementKkiapayDto);
  }

  @ApiOperation({ summary: 'Remboursement d\'un paiement par Kkiapay' })
  @RequirePermission(Modules.COMMANDES, Action.UPDATE) // Admin et Manager peuvent rembourser
  @UserRoles(UserRole.ADMIN, UserRole.MANAGER)
  @UseGuards(JwtAuthGuard)
  @Post('refund/:id')
  refundPaiement(@Param('id') paiementId: string) {
    return this.paiementsService.refundPaiement(paiementId);
  }

  @ApiOperation({ summary: 'Obtenir les paiements libres' })
  @UseGuards(JwtCustomerAuthGuard)
  @RequirePermission(Modules.COMMANDES, Action.READ) // Caissier et Call Center peuvent lire
  @UserRoles(UserRole.CAISSIER, UserRole.CALL_CENTER)
  @Get('free')
  getFreePaiements(@Req() req: Request) {
    return this.paiementsService.getFreePaiements(req);
  }

  @ApiOperation({ summary: 'Créer un paiement' })
  @RequirePermission(Modules.COMMANDES, Action.CREATE)
  @UserRoles(UserRole.ADMIN, UserRole.MANAGER)
  @Post()
  create(@Body() createPaiementDto: CreatePaiementDto) {
    return this.paiementsService.create(createPaiementDto);
  }

  @ApiOperation({ summary: 'Lister tous les paiements' })
  @RequirePermission(Modules.COMMANDES, Action.READ)
  @UserRoles(UserRole.ADMIN, UserRole.MANAGER, UserRole.CAISSIER)
  @UseGuards(JwtAuthGuard)
  @Get()
  findAll(@Query() queryDto: QueryPaiementDto) {
    return this.paiementsService.findAll(queryDto);
  }

  @ApiOperation({ summary: 'Obtenir un paiement par son ID' })
  @RequirePermission(Modules.COMMANDES, Action.READ)
  @UserRoles(UserRole.ADMIN, UserRole.MANAGER, UserRole.CAISSIER)
  @UseGuards(JwtAuthGuard)
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.paiementsService.findOne(id);
  }

  @ApiOperation({ summary: 'Supprimer un paiement' })
  @RequirePermission(Modules.COMMANDES, Action.DELETE)
  @UserRoles(UserRole.ADMIN, UserRole.MANAGER)
  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.paiementsService.remove(id);
  }
}
