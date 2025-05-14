import { Controller, Get, Post, Body, Param, Delete, Query, UseGuards, Req } from '@nestjs/common';
import { PaiementsService } from 'src/modules/paiements/services/paiements.service';
import { CreatePaiementDto } from 'src/modules/paiements/dto/create-paiement.dto';
import { QueryPaiementDto } from 'src/modules/paiements/dto/query-paiement.dto';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserRole } from '@prisma/client';
import { UserRoles } from 'src/common/decorators/user-roles.decorator';
import { CreatePaiementKkiapayDto } from '../dto/create-paiement-kkiapay.dto';
import { JwtCustomerAuthGuard } from 'src/modules/auth/guards/jwt-customer-auth.guard';
import { Request } from 'express';

@ApiTags('Paiements')
@Controller('paiements')
export class PaiementsController {
  constructor(private readonly paiementsService: PaiementsService) { }

  @UseGuards(JwtCustomerAuthGuard)
  @ApiOperation({ summary: 'Payer avec Kkiapay' })
  @Post('pay')
  payWithKkiapay(@Req() req: Request, @Body() createPaiementKkiapayDto: CreatePaiementKkiapayDto) {
    return this.paiementsService.payWithKkiapay(req, createPaiementKkiapayDto);
  }

  @ApiOperation({ summary: 'Remboursement d\'un paiement par Kkiapay' })
  @UseGuards(JwtAuthGuard)
  @Post('refund/:id')
  refundPaiement(@Param('id') paiementId: string) {
    return this.paiementsService.refundPaiement(paiementId);
  }

  @ApiOperation({ summary: 'Obtenir les paiements libres' })
  @UseGuards(JwtCustomerAuthGuard)
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
  @UseGuards(JwtAuthGuard)
  @Get()
  findAll(@Query() queryDto: QueryPaiementDto) {
    return this.paiementsService.findAll(queryDto);
  }

  @ApiOperation({ summary: 'Obtenir un paiement par son ID' })
  @UseGuards(JwtAuthGuard)
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.paiementsService.findOne(id);
  }

  // @ApiOperation({ summary: 'Mettre à jour un paiement' })
  // @UseGuards(JwtAuthGuard, JwtCustomerAuthGuard)
  // @Patch(':id')
  // update(@Param('id') id: string, @Body() updatePaiementDto: UpdatePaiementDto) {
  //   return this.paiementsService.update(id, updatePaiementDto);
  // }

  @ApiOperation({ summary: 'Supprimer un paiement' })
  @UserRoles(UserRole.ADMIN, UserRole.MANAGER)
  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.paiementsService.remove(id);
  }
}
