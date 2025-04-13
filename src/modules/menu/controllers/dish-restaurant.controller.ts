import { Controller, Get, Post, Body, Param, Delete, UseGuards } from '@nestjs/common';
import { DishRestaurantService } from 'src/modules/menu/services/dish-restaurant.service';
import { CreateDishRestaurantDto } from 'src/modules/menu/dto/create-dish-restaurant.dto';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserRolesGuard } from 'src/common/guards/user-roles.guard';
import { UserRoles } from 'src/common/decorators/user-roles.decorator';
import { UserRole, UserType } from '@prisma/client';
import { UserTypesGuard } from 'src/common/guards/user-types.guard';
import { UserTypes } from 'src/common/decorators/user-types.decorator';

@Controller('dish-restaurants')
export class DishRestaurantController {
  constructor(private readonly dishRestaurantService: DishRestaurantService) { }

  @Post()
  @UseGuards(JwtAuthGuard, UserTypesGuard, UserRolesGuard)
  @UserTypes(UserType.BACKOFFICE, UserType.RESTAURANT)
  @UserRoles(UserRole.ADMIN, UserRole.MANAGER)
  create(@Body() createDishRestaurantDto: CreateDishRestaurantDto) {
    return this.dishRestaurantService.create(createDishRestaurantDto);
  }

  @Get()
  findAll() {
    return this.dishRestaurantService.findAll();
  }

  @Get('dish/:dishId')
  findByDish(@Param('dishId') dishId: string) {
    return this.dishRestaurantService.findByDish(dishId);
  }

  @Get('restaurant/:restaurantId')
  findByRestaurant(@Param('restaurantId') restaurantId: string) {
    return this.dishRestaurantService.findByRestaurant(restaurantId);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, UserTypesGuard, UserRolesGuard)
  @UserTypes(UserType.BACKOFFICE, UserType.RESTAURANT)
  @UserRoles(UserRole.ADMIN, UserRole.MANAGER)
  remove(@Param('id') id: string) {
    return this.dishRestaurantService.remove(id);
  }

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