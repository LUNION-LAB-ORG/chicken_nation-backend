import { Controller, Get, Post, Body, Param, Delete, Put, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { RestaurantSchedulesService } from '../services/restaurant-schedules.service';
import { CreateRestaurantScheduleDto } from '../dto/create-restaurant-schedule.dto';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';

@ApiTags('restaurant-schedules')
@Controller('restaurants/:restaurantId/schedules')
export class RestaurantSchedulesController {
  constructor(private readonly schedulesService: RestaurantSchedulesService) {}

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Créer un nouvel horaire pour un restaurant' })
  @ApiResponse({ status: 201, description: 'Horaire créé avec succès' })
  create(
    @Param('restaurantId') restaurantId: string,
    @Body() createScheduleDto: CreateRestaurantScheduleDto,
  ) {
    return this.schedulesService.create(restaurantId, createScheduleDto);
  }

  @Post('bulk')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Créer ou mettre à jour plusieurs horaires pour un restaurant' })
  @ApiResponse({ status: 201, description: 'Horaires créés ou mis à jour avec succès' })
  createOrUpdateBulk(
    @Param('restaurantId') restaurantId: string,
    @Body() schedulesData: CreateRestaurantScheduleDto[],
  ) {
    return this.schedulesService.createOrUpdateBulk(restaurantId, schedulesData);
  }

  @Get()
  @ApiOperation({ summary: 'Récupérer tous les horaires d\'un restaurant' })
  @ApiResponse({ status: 200, description: 'Liste des horaires récupérée avec succès' })
  findAll(@Param('restaurantId') restaurantId: string) {
    return this.schedulesService.findAllForRestaurant(restaurantId);
  }

  @Get(':day')
  @ApiOperation({ summary: 'Récupérer un horaire spécifique d\'un restaurant' })
  @ApiResponse({ status: 200, description: 'Horaire récupéré avec succès' })
  @ApiResponse({ status: 404, description: 'Horaire non trouvé' })
  findOne(
    @Param('restaurantId') restaurantId: string,
    @Param('day') day: string,
  ) {
    return this.schedulesService.findOne(restaurantId, day);
  }

  @Put(':day')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Mettre à jour un horaire de restaurant' })
  @ApiResponse({ status: 200, description: 'Horaire mis à jour avec succès' })
  @ApiResponse({ status: 404, description: 'Horaire non trouvé' })
  update(
    @Param('restaurantId') restaurantId: string,
    @Param('day') day: string,
    @Body() updateScheduleDto: CreateRestaurantScheduleDto,
  ) {
    return this.schedulesService.update(restaurantId, day, updateScheduleDto);
  }

  @Delete(':day')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Supprimer un horaire de restaurant' })
  @ApiResponse({ status: 200, description: 'Horaire supprimé avec succès' })
  @ApiResponse({ status: 404, description: 'Horaire non trouvé' })
  remove(
    @Param('restaurantId') restaurantId: string,
    @Param('day') day: string,
  ) {
    return this.schedulesService.remove(restaurantId, day);
  }
}
