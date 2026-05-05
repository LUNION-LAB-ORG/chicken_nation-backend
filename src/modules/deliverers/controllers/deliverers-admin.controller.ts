import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Query, UseGuards } from '@nestjs/common';
import { ApiBody, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';

import { UserRoles } from 'src/modules/auth/decorators/user-roles.decorator';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserRolesGuard } from 'src/modules/auth/guards/user-roles.guard';

import { AssignRestaurantDto } from '../dto/assign-restaurant.dto';
import { QueryDeliverersDto } from '../dto/query-deliverers.dto';
import { RejectDelivererDto, SuspendDelivererDto } from '../dto/reject-deliverer.dto';
import { DelivererInfoService } from '../services/deliverer-info.service';
import { DeliverersService } from '../services/deliverers.service';

/**
 * Endpoints réservés aux utilisateurs backoffice (admin / manager).
 * Protégés par JwtAuthGuard + UserRolesGuard.
 */
@ApiTags('Deliverers — Admin')
@Controller('deliverers')
@UseGuards(JwtAuthGuard, UserRolesGuard)
// Restriction stricte : seul l'ADMIN gère les livreurs pour l'instant.
// Un rôle dédié (ex: RESPONSABLE_LIVREURS) pourra être ajouté plus tard.
@UserRoles(UserRole.ADMIN)
export class DeliverersAdminController {
  constructor(
    private readonly deliverersService: DeliverersService,
    private readonly delivererInfoService: DelivererInfoService,
  ) {}

  @ApiOperation({ summary: 'Liste paginée des livreurs avec filtres' })
  @Get()
  async findAll(@Query() query: QueryDeliverersDto) {
    return this.deliverersService.findAll(query);
  }

  @ApiOperation({
    summary: 'Positions GPS live des livreurs (dashboard carte temps réel)',
    description:
      'Retourne les livreurs ACTIVE operationnels avec GPS récent + statut ' +
      'availability + course active éventuelle. Les livreurs sans GPS récent ' +
      '(> `deliverer.gps_expiration_minutes`) sont exclus par défaut.',
  })
  @Get('live-locations')
  async getLiveLocations(
    @Query('restaurantId') restaurantId?: string,
    @Query('includeOffline') includeOffline?: string,
  ) {
    return this.deliverersService.getLiveLocations({
      restaurantId,
      includeOffline: includeOffline === 'true',
    });
  }

  @ApiOperation({ summary: "Détail d'un livreur" })
  @Get(':id')
  async findOne(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.deliverersService.findOne(id);
  }

  @ApiOperation({
    summary: 'Vue scoring + queue + refus + pause d\'un livreur (admin)',
    description:
      "Même payload que `/deliverers/me/scoring-info` mais ciblé sur n'importe quel livreur. " +
      'Consommé par le drawer livreur du backoffice pour afficher la section "Scoring & Queue".',
  })
  @Get(':id/scoring-info')
  async getScoringInfo(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.delivererInfoService.getScoringInfo(id);
  }

  @ApiOperation({ summary: 'Valider un livreur en attente (PENDING → ACTIVE)' })
  @Patch(':id/validate')
  async validate(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.deliverersService.validate(id);
  }

  @ApiOperation({ summary: 'Refuser un livreur' })
  @ApiBody({ type: RejectDelivererDto })
  @Patch(':id/reject')
  async reject(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: RejectDelivererDto,
  ) {
    return this.deliverersService.reject(id, dto.reason);
  }

  @ApiOperation({ summary: 'Suspendre un livreur' })
  @ApiBody({ type: SuspendDelivererDto })
  @Patch(':id/suspend')
  async suspend(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: SuspendDelivererDto,
  ) {
    return this.deliverersService.suspend(id, dto.reason);
  }

  @ApiOperation({ summary: 'Réactiver un livreur suspendu (SUSPENDED → ACTIVE)' })
  @Patch(':id/reactivate')
  async reactivate(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.deliverersService.reactivate(id);
  }

  @ApiOperation({ summary: 'Affecter / réaffecter un restaurant au livreur' })
  @ApiBody({ type: AssignRestaurantDto })
  @Patch(':id/assign-restaurant')
  async assignRestaurant(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: AssignRestaurantDto,
  ) {
    return this.deliverersService.assignRestaurant(id, dto);
  }

  @ApiOperation({ summary: 'Supprimer un livreur (soft delete)' })
  @Delete(':id')
  async remove(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.deliverersService.softDelete(id);
  }
}
