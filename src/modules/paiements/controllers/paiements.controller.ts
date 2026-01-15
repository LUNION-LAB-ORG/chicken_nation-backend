import { Body, Controller, Delete, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { AddPaiementDto, CreatePaiementDto } from 'src/modules/paiements/dto/create-paiement.dto';
import { QueryPaiementDto } from 'src/modules/paiements/dto/query-paiement.dto';
import { PaiementsService } from 'src/modules/paiements/services/paiements.service';
import { CreatePaiementKkiapayDto } from '../dto/create-paiement-kkiapay.dto';

import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';

@ApiTags('Paiements')
@Controller('paiements')
export class PaiementsController {
  constructor(private readonly paiementsService: PaiementsService) { }

  @Post('add')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Payer via backoffice' })
  addPaiement(@Req() req: Request, @Body() data: AddPaiementDto) {
    return this.paiementsService.addPaiement(req, data);
  }

  @Post('pay')
  @ApiOperation({ summary: 'Payer avec Kkiapay' })
  payWithKkiapay(@Req() req: Request, @Body() createPaiementKkiapayDto: CreatePaiementKkiapayDto) {
    return this.paiementsService.payWithKkiapay(req, createPaiementKkiapayDto);
  }

  @Post('refund/:id')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Remboursement d\'un paiement par Kkiapay' })
  refundPaiement(@Param('id') paiementId: string) {
    return this.paiementsService.refundPaiement(paiementId);
  }

  @Get('free')
  @ApiOperation({ summary: 'Obtenir les paiements libres' })
  getFreePaiements(@Req() req: Request) {
    return this.paiementsService.getFreePaiements(req);
  }

  @Post()
  @ApiOperation({ summary: 'Créer un paiement' })
  create(@Body() createPaiementDto: CreatePaiementDto) {
    return this.paiementsService.create(createPaiementDto);
  }

  @Get()
  @ApiOperation({ summary: 'Lister tous les paiements' })
  findAll(@Query() queryDto: QueryPaiementDto) {
    return this.paiementsService.findAll(queryDto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtenir un paiement par son ID' })
  findOne(@Param('id') id: string) {
    return this.paiementsService.findOne(id);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Supprimer un paiement' })
  remove(@Param('id') id: string) {
    return this.paiementsService.remove(id);
  }
}
