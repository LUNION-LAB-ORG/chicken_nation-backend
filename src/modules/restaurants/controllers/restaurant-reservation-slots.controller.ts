import { Controller, Get, Post, Body, Param, Delete, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { RestaurantReservationSlotsService } from '../services/restaurant-reservation-slots.service';
import { CreateReservationSlotDto } from '../dto/create-reservation-slot.dto';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';

@ApiTags('restaurant-reservation-slots')
@Controller('restaurants/:restaurantId/reservation-slots')
export class RestaurantReservationSlotsController {
  constructor(private readonly slotsService: RestaurantReservationSlotsService) {}

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Cru00e9er un nouveau cru00e9neau de ru00e9servation pour un restaurant' })
  @ApiResponse({ status: 201, description: 'Cru00e9neau cru00e9u00e9 avec succu00e8s' })
  create(
    @Param('restaurantId') restaurantId: string,
    @Body() createSlotDto: CreateReservationSlotDto,
  ) {
    return this.slotsService.create(restaurantId, createSlotDto);
  }

  @Post('bulk')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Cru00e9er ou mettre u00e0 jour plusieurs cru00e9neaux de ru00e9servation pour un restaurant' })
  @ApiResponse({ status: 201, description: 'Cru00e9neaux cru00e9u00e9s ou mis u00e0 jour avec succu00e8s' })
  createOrUpdateBulk(
    @Param('restaurantId') restaurantId: string,
    @Body() slotsData: CreateReservationSlotDto[],
  ) {
    return this.slotsService.createOrUpdateBulk(restaurantId, slotsData);
  }

  @Get()
  @ApiOperation({ summary: 'Ru00e9cupu00e9rer tous les cru00e9neaux de ru00e9servation d\'un restaurant' })
  @ApiResponse({ status: 200, description: 'Liste des cru00e9neaux ru00e9cupu00e9ru00e9e avec succu00e8s' })
  findAll(@Param('restaurantId') restaurantId: string) {
    return this.slotsService.findAllForRestaurant(restaurantId);
  }

  @Get(':timeSlot')
  @ApiOperation({ summary: 'Ru00e9cupu00e9rer un cru00e9neau de ru00e9servation spu00e9cifique d\'un restaurant' })
  @ApiResponse({ status: 200, description: 'Cru00e9neau ru00e9cupu00e9ru00e9 avec succu00e8s' })
  @ApiResponse({ status: 404, description: 'Cru00e9neau non trouvu00e9' })
  findOne(
    @Param('restaurantId') restaurantId: string,
    @Param('timeSlot') timeSlot: string,
  ) {
    return this.slotsService.findOne(restaurantId, timeSlot);
  }

  @Delete(':timeSlot')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Supprimer un cru00e9neau de ru00e9servation' })
  @ApiResponse({ status: 200, description: 'Cru00e9neau supprimu00e9 avec succu00e8s' })
  @ApiResponse({ status: 404, description: 'Cru00e9neau non trouvu00e9' })
  remove(
    @Param('restaurantId') restaurantId: string,
    @Param('timeSlot') timeSlot: string,
  ) {
    return this.slotsService.remove(restaurantId, timeSlot);
  }
}
