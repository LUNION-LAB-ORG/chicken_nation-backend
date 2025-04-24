import { Controller, Get, Post, Body, Param, Delete, UseGuards } from '@nestjs/common';
import { DishRestaurantService } from 'src/modules/menu/services/dish-restaurant.service';
import { CreateDishRestaurantDto } from 'src/modules/menu/dto/create-dish-restaurant.dto';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserRolesGuard } from 'src/common/guards/user-roles.guard';
import { UserRoles } from 'src/common/decorators/user-roles.decorator';
import { UserRole, UserType } from '@prisma/client';
import { UserTypesGuard } from 'src/common/guards/user-types.guard';
import { UserTypes } from 'src/common/decorators/user-types.decorator';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';

@ApiTags('Dish Restaurants')
@ApiBearerAuth()
@Controller('dish-restaurants')
export class DishRestaurantController {
  constructor(private readonly dishRestaurantService: DishRestaurantService) { }

  @ApiOperation({ summary: 'Création d\'une nouvelle relation entre plat et restaurant' })
  @Post()
  @UseGuards(JwtAuthGuard, UserTypesGuard, UserRolesGuard)
  @UserTypes(UserType.BACKOFFICE, UserType.RESTAURANT)
  @UserRoles(UserRole.ADMIN, UserRole.MANAGER)
  create(@Body() createDishRestaurantDto: CreateDishRestaurantDto) {
    return this.dishRestaurantService.create(createDishRestaurantDto);
  }

  @ApiOperation({ summary: 'Récupération de toutes les relations entre plats et restaurants' })
  @Get()
  findAll() {
    return this.dishRestaurantService.findAll();
  }

  @ApiOperation({ summary: 'Suppression d\'une relation entre plat et restaurant' })
  @Delete(':id')
  @UseGuards(JwtAuthGuard, UserTypesGuard, UserRolesGuard)
  @UserTypes(UserType.BACKOFFICE, UserType.RESTAURANT)
  @UserRoles(UserRole.ADMIN, UserRole.MANAGER)
  remove(@Param('id') id: string) {
    return this.dishRestaurantService.remove(id);
  }

  @ApiOperation({ summary: 'Suppression d\'une relation entre plat et restaurant' })
  @Delete('dish/:dishId/restaurant/:restaurantId')
  @UseGuards(JwtAuthGuard, UserTypesGuard, UserRolesGuard)
  @UserTypes(UserType.BACKOFFICE, UserType.RESTAURANT)
  @UserRoles(UserRole.ADMIN, UserRole.MANAGER)
  removeByDishAndRestaurant(
    @Param('dishId') dishId: string,
    @Param('restaurantId') restaurantId: string,
  ) {
    return this.dishRestaurantService.removeByDishAndRestaurant(dishId, restaurantId);
  }
}