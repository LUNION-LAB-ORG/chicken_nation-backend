import { Controller, Get, Post, Body, Patch, Param, Delete, Query, UseGuards } from '@nestjs/common';
import { PaiementsService } from 'src/modules/paiements/services/paiements.service';
import { CreatePaiementDto } from 'src/modules/paiements/dto/create-paiement.dto';
import { UpdatePaiementDto } from 'src/modules/paiements/dto/update-paiement.dto';
import { QueryPaiementDto } from 'src/modules/paiements/dto/query-paiement.dto';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { JwtCustomerAuthGuard } from 'src/modules/auth/guards/jwt-customer-auth.guard';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserRole } from '@prisma/client';
import { UserRoles } from 'src/common/decorators/user-roles.decorator';

@ApiTags('Paiements')
@Controller('paiements')
export class PaiementsController {
  constructor(private readonly paiementsService: PaiementsService) { }

  @ApiOperation({ summary: 'Créer un paiement' })
  @UseGuards(JwtCustomerAuthGuard)
  @Post()
  create(@Body() createPaiementDto: CreatePaiementDto) {
    return this.paiementsService.create(createPaiementDto);
  }

  @ApiOperation({ summary: 'Lister tous les paiements' })
  @UseGuards(JwtAuthGuard, JwtCustomerAuthGuard)
  @Get()
  findAll(@Query() queryDto: QueryPaiementDto) {
    return this.paiementsService.findAll(queryDto);
  }

  @ApiOperation({ summary: 'Obtenir un paiement par son ID' })
  @UseGuards(JwtAuthGuard, JwtCustomerAuthGuard)
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.paiementsService.findOne(id);
  }

  @ApiOperation({ summary: 'Mettre à jour un paiement' })
  @UseGuards(JwtAuthGuard, JwtCustomerAuthGuard)
  @Patch(':id')
  update(@Param('id') id: string, @Body() updatePaiementDto: UpdatePaiementDto) {
    return this.paiementsService.update(id, updatePaiementDto);
  }

  @ApiOperation({ summary: 'Supprimer un paiement' })
  @UserRoles(UserRole.ADMIN, UserRole.MANAGER)
  @UseGuards(JwtAuthGuard)
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.paiementsService.remove(id);
  }
}
