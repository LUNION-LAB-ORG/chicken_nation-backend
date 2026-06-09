import { Body, Controller, Delete, ForbiddenException, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { User, UserRole } from '@prisma/client';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { AddPaiementDto, CreatePaiementDto } from 'src/modules/paiements/dto/create-paiement.dto';
import { QueryPaiementDto } from 'src/modules/paiements/dto/query-paiement.dto';
import { UpdatePaiementDto } from 'src/modules/paiements/dto/update-paiement.dto';
import { PaiementsService } from 'src/modules/paiements/services/paiements.service';
import { CreatePaiementKkiapayDto } from '../dto/create-paiement-kkiapay.dto';

import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

/** Garde-fou commun aux endpoints d'édition/suppression de paiement : seul un
 *  ADMIN peut corriger un paiement déjà enregistré (audit comptable, erreur de
 *  saisie). Pour les autres rôles, on lève 403. */
function assertAdmin(req: Request) {
  const user = req.user as User | undefined;
  if (user?.role !== UserRole.ADMIN) {
    throw new ForbiddenException(
      "Seul un administrateur peut modifier ou supprimer un paiement existant.",
    );
  }
}

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

  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: "Modifier un paiement (admin uniquement). Recalcule order.paied." })
  update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: UpdatePaiementDto,
  ) {
    assertAdmin(req);
    return this.paiementsService.update(id, dto);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Supprimer un paiement (admin uniquement). Recalcule order.paied.' })
  remove(@Req() req: Request, @Param('id') id: string) {
    assertAdmin(req);
    return this.paiementsService.remove(id);
  }
}
