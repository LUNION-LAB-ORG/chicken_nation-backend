import { Controller, Get, Post, Body, Patch, Param, Delete, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { RestaurantsService } from '../services/restaurants.service';
import { CreateRestaurantDto } from '../dto/create-restaurant.dto';
import { UpdateRestaurantDto } from '../dto/update-restaurant.dto';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';

@ApiTags('restaurants')
@Controller('restaurants')
export class RestaurantsController {
  constructor(private readonly restaurantsService: RestaurantsService) {}

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Créer un nouveau restaurant' })
  @ApiResponse({ status: 201, description: 'Restaurant créé avec succès' })
  create(@Body() createRestaurantDto: CreateRestaurantDto) {
    return this.restaurantsService.create(createRestaurantDto);
  }

  @Get()
  @ApiOperation({ summary: 'Récupérer tous les restaurants' })
  @ApiQuery({ name: 'isOpen', required: false, type: Boolean })
  @ApiQuery({ name: 'location', required: false })
  @ApiResponse({ status: 200, description: 'Liste des restaurants récupérée avec succès' })
  findAll(
    @Query('isOpen') isOpen?: string,
    @Query('location') location?: string,
  ) {
    const options: any = {};
    
    if (isOpen !== undefined) {
      options.isOpen = isOpen === 'true';
    }
    
    if (location) {
      options.location = location;
    }
    
    return this.restaurantsService.findAll(options);
  }

  @Get('search')
  @ApiOperation({ summary: 'Rechercher des restaurants par nom' })
  @ApiQuery({ name: 'name', required: true })
  @ApiResponse({ status: 200, description: 'Résultats de recherche récupérés avec succès' })
  search(@Query('name') name: string) {
    return this.restaurantsService.searchByName(name);
  }

  @Get('top-rated')
  @ApiOperation({ summary: 'Récupérer les restaurants les mieux notés' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'Liste des restaurants les mieux notés récupérée avec succès' })
  getTopRated(@Query('limit') limit?: number) {
    return this.restaurantsService.getTopRated(limit ? parseInt(limit.toString()) : 10);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Récupérer un restaurant par son ID' })
  @ApiResponse({ status: 200, description: 'Restaurant récupéré avec succès' })
  @ApiResponse({ status: 404, description: 'Restaurant non trouvé' })
  findOne(@Param('id') id: string) {
    return this.restaurantsService.findOne(id);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Mettre à jour un restaurant' })
  @ApiResponse({ status: 200, description: 'Restaurant mis à jour avec succès' })
  @ApiResponse({ status: 404, description: 'Restaurant non trouvé' })
  update(@Param('id') id: string, @Body() updateRestaurantDto: UpdateRestaurantDto) {
    return this.restaurantsService.update(id, updateRestaurantDto);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Supprimer un restaurant' })
  @ApiResponse({ status: 200, description: 'Restaurant supprimé avec succès' })
  @ApiResponse({ status: 404, description: 'Restaurant non trouvé' })
  remove(@Param('id') id: string) {
    return this.restaurantsService.remove(id);
  }
}
