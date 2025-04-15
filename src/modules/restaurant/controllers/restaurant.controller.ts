import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards, Query, Request, HttpStatus, HttpCode } from '@nestjs/common';
import { RestaurantService } from 'src/modules/restaurant/services/restaurant.service';
import { CreateRestaurantDto } from 'src/modules/restaurant/dto/create-restaurant.dto';
import { UpdateRestaurantDto } from 'src/modules/restaurant/dto/update-restaurant.dto';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserRoles } from 'src/common/decorators/user-roles.decorator';
import { UserRole, UserType } from '@prisma/client';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { UserRolesGuard } from 'src/common/guards/user-roles.guard';
import { UserTypesGuard } from 'src/common/guards/user-types.guard';
import { UserTypes } from 'src/common/decorators/user-types.decorator';

@ApiTags('Restaurants')
@Controller('restaurants')
export class RestaurantController {
  constructor(private readonly restaurantService: RestaurantService) { }

  @ApiOperation({ summary: 'Création d\'un restaurant avec son gestionnaire' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, UserRolesGuard, UserTypesGuard)
  @UserRoles(UserRole.ADMIN)
  @UserTypes(UserType.BACKOFFICE)
  @Post()
  async create(@Body() createRestaurantDto: CreateRestaurantDto) {
    return this.restaurantService.create(createRestaurantDto);
  }

  @ApiOperation({ summary: 'Obtenir tous les restaurants' })
  @Get()
  async findAll(
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.restaurantService.findAll(page || 1, limit || 10);
  }

  @ApiOperation({ summary: 'Obtenir un restaurant par ID' })
  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.restaurantService.findOne(id);
  }

  @ApiOperation({ summary: 'Mettre à jour un restaurant' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, UserRolesGuard, UserTypesGuard)
  @UserRoles(UserRole.ADMIN, UserRole.MANAGER)
  @UserTypes(UserType.BACKOFFICE, UserType.RESTAURANT)
  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body() updateRestaurantDto: UpdateRestaurantDto,
    @Request() req,
  ) {
    return this.restaurantService.update(id, updateRestaurantDto, req.user.id);
  }

  @ApiOperation({ summary: 'Activer un restaurant' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, UserRolesGuard, UserTypesGuard)
  @UserRoles(UserRole.ADMIN, UserRole.MANAGER)
  @UserTypes(UserType.BACKOFFICE, UserType.RESTAURANT)
  @Patch(':id/activate')
  async activate(@Param('id') id: string, @Request() req) {
    return this.restaurantService.activate(id, req.user.id);
  }

  @ApiOperation({ summary: 'Désactiver un restaurant' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, UserRolesGuard, UserTypesGuard)
  @UserRoles(UserRole.ADMIN, UserRole.MANAGER)
  @UserTypes(UserType.BACKOFFICE, UserType.RESTAURANT)
  @Patch(':id/deactivate')
  async deactivate(@Param('id') id: string, @Request() req) {
    return this.restaurantService.deactivate(id, req.user.id);
  }

  @ApiOperation({ summary: 'Supprimer un restaurant' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, UserRolesGuard, UserTypesGuard)
  @UserRoles(UserRole.ADMIN)
  @UserTypes(UserType.BACKOFFICE)
  @Delete(':id')
  async remove(@Param('id') id: string, @Request() req) {
    return this.restaurantService.remove(id, req.user.id);
  }

  @ApiOperation({ summary: 'Obtenir tous les utilisateurs d un restaurant' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, UserRolesGuard, UserTypesGuard)
  @UserRoles(UserRole.ADMIN, UserRole.MANAGER)
  @UserTypes(UserType.BACKOFFICE, UserType.RESTAURANT)
  @Get(':id/users')
  async getRestaurantUsers(@Param('id') id: string, @Request() req) {
    return this.restaurantService.getRestaurantUsers(id, req.user.id);
  }
}