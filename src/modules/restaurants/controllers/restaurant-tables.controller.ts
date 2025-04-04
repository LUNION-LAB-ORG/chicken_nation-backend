import { Controller, Get, Post, Body, Param, Delete, Put, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { RestaurantTablesService } from '../services/restaurant-tables.service';
import { CreateRestaurantTableDto } from '../dto/create-restaurant-table.dto';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';

@ApiTags('restaurant-tables')
@Controller('restaurants/:restaurantId/tables')
export class RestaurantTablesController {
  constructor(private readonly tablesService: RestaurantTablesService) {}

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Créer une nouvelle configuration de table pour un restaurant' })
  @ApiResponse({ status: 201, description: 'Configuration de table créée avec succès' })
  create(
    @Param('restaurantId') restaurantId: string,
    @Body() createTableDto: CreateRestaurantTableDto,
  ) {
    return this.tablesService.create(restaurantId, createTableDto);
  }

  @Post('bulk')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Créer ou mettre à jour plusieurs configurations de tables pour un restaurant' })
  @ApiResponse({ status: 201, description: 'Configurations de tables créées ou mises à jour avec succès' })
  createOrUpdateBulk(
    @Param('restaurantId') restaurantId: string,
    @Body() tablesData: CreateRestaurantTableDto[],
  ) {
    return this.tablesService.createOrUpdateBulk(restaurantId, tablesData);
  }

  @Get()
  @ApiOperation({ summary: 'Récupérer toutes les configurations de tables d\'un restaurant' })
  @ApiResponse({ status: 200, description: 'Liste des configurations de tables récupérée avec succès' })
  findAll(@Param('restaurantId') restaurantId: string) {
    return this.tablesService.findAllForRestaurant(restaurantId);
  }

  @Get(':capacity/:type')
  @ApiOperation({ summary: 'Récupérer une configuration de table spécifique d\'un restaurant' })
  @ApiResponse({ status: 200, description: 'Configuration de table récupérée avec succès' })
  @ApiResponse({ status: 404, description: 'Configuration de table non trouvée' })
  findOne(
    @Param('restaurantId') restaurantId: string,
    @Param('capacity') capacity: string,
    @Param('type') type: string,
  ) {
    return this.tablesService.findOne(restaurantId, parseInt(capacity), type);
  }

  @Put(':capacity/:type')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Mettre à jour une configuration de table de restaurant' })
  @ApiResponse({ status: 200, description: 'Configuration de table mise à jour avec succès' })
  @ApiResponse({ status: 404, description: 'Configuration de table non trouvée' })
  update(
    @Param('restaurantId') restaurantId: string,
    @Param('capacity') capacity: string,
    @Param('type') type: string,
    @Body() updateData: { quantity: number },
  ) {
    return this.tablesService.update(restaurantId, parseInt(capacity), type, updateData);
  }

  @Delete(':capacity/:type')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Supprimer une configuration de table de restaurant' })
  @ApiResponse({ status: 200, description: 'Configuration de table supprimée avec succès' })
  @ApiResponse({ status: 404, description: 'Configuration de table non trouvée' })
  remove(
    @Param('restaurantId') restaurantId: string,
    @Param('capacity') capacity: string,
    @Param('type') type: string,
  ) {
    return this.tablesService.remove(restaurantId, parseInt(capacity), type);
  }
}
