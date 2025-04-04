import { Controller, Get, Post, Body, Param, Put, UseGuards, Query, Request } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { TableReservationsService } from '../services/table-reservations.service';
import { CreateTableReservationDto } from '../dto/create-table-reservation.dto';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';

@ApiTags('table-reservations')
@Controller('table-reservations')
export class TableReservationsController {
  constructor(private readonly reservationsService: TableReservationsService) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Créer une nouvelle réservation de table' })
  @ApiResponse({ status: 201, description: 'Réservation créée avec succès' })
  create(@Request() req, @Body() createReservationDto: CreateTableReservationDto) {
    return this.reservationsService.create(req.user.id, createReservationDto);
  }

  @Get('my-reservations')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Récupérer toutes les réservations de l\'utilisateur connecté' })
  @ApiResponse({ status: 200, description: 'Liste des réservations récupérée avec succès' })
  findAllForUser(@Request() req) {
    return this.reservationsService.findAllForUser(req.user.id);
  }

  @Get('my-upcoming-reservations')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Récupérer les réservations à venir de l\'utilisateur connecté' })
  @ApiResponse({ status: 200, description: 'Liste des réservations à venir récupérée avec succès' })
  findUpcomingForUser(@Request() req) {
    return this.reservationsService.findUpcomingForUser(req.user.id);
  }

  @Get('restaurant/:restaurantId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Récupérer toutes les réservations pour un restaurant' })
  @ApiQuery({ name: 'date', required: false, type: String })
  @ApiResponse({ status: 200, description: 'Liste des réservations récupérée avec succès' })
  findAllForRestaurant(
    @Param('restaurantId') restaurantId: string,
    @Query('date') date?: string,
  ) {
    return this.reservationsService.findAllForRestaurant(restaurantId, date);
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Récupérer une réservation par son ID' })
  @ApiResponse({ status: 200, description: 'Réservation récupérée avec succès' })
  @ApiResponse({ status: 404, description: 'Réservation non trouvée' })
  findOne(@Param('id') id: string, @Request() req) {
    return this.reservationsService.findOne(id);
  }

  @Put(':id/status')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Mettre à jour le statut d\'une réservation' })
  @ApiResponse({ status: 200, description: 'Statut mis à jour avec succès' })
  @ApiResponse({ status: 404, description: 'Réservation non trouvée' })
  updateStatus(
    @Param('id') id: string,
    @Body() statusData: { status: 'pending' | 'confirmed' | 'cancelled' },
  ) {
    return this.reservationsService.updateStatus(id, statusData.status);
  }

  @Put(':id/cancel')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Annuler une réservation' })
  @ApiResponse({ status: 200, description: 'Réservation annulée avec succès' })
  @ApiResponse({ status: 400, description: 'Impossible d\'annuler cette réservation' })
  @ApiResponse({ status: 404, description: 'Réservation non trouvée' })
  cancel(@Param('id') id: string, @Request() req) {
    return this.reservationsService.cancel(id, req.user.id);
  }
}
