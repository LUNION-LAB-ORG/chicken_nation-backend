import {
  Controller,
  Get,
  Post,
  Body,
  Delete,
  Param,
  UseGuards,
} from '@nestjs/common';
import { DishRestaurantService } from 'src/modules/menu/services/dish-restaurant.service';
import { CreateDishRestaurantDto } from 'src/modules/menu/dto/create-dish-restaurant.dto';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserRole, UserType } from '@prisma/client';
import { UserTypesGuard } from 'src/common/guards/user-types.guard';
import { UserTypes } from 'src/common/decorators/user-types.decorator';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { UserPermissionsGuard } from 'src/common/guards/user-permissions.guard';
import { UserRoles } from 'src/common/decorators/user-roles.decorator';
import { RequirePermission } from 'src/common/decorators/user-require-permission';

@ApiTags('Dish Restaurants')
@ApiBearerAuth()
@Controller('dish-restaurants')
export class DishRestaurantController {
  constructor(private readonly dishRestaurantService: DishRestaurantService) {}

  @Post()
  @UseGuards(JwtAuthGuard, UserTypesGuard, UserPermissionsGuard)
  @UserTypes(UserType.BACKOFFICE, UserType.RESTAURANT)
  @UserRoles(UserRole.ADMIN, UserRole.MARKETING)
  @RequirePermission('plats', 'create')
  @ApiOperation({ summary: "Création d'une nouvelle relation entre plat et restaurant" })
  create(@Body() createDishRestaurantDto: CreateDishRestaurantDto) {
    return this.dishRestaurantService.create(createDishRestaurantDto);
  }

  @Get()
  @UseGuards(UserPermissionsGuard)
  @RequirePermission('plats', 'read')
  @ApiOperation({ summary: 'Récupération de toutes les relations entre plats et restaurants' })
  findAll() {
    return this.dishRestaurantService.findAll();
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, UserTypesGuard, UserPermissionsGuard)
  @UserTypes(UserType.BACKOFFICE, UserType.RESTAURANT)
  @UserRoles(UserRole.ADMIN, UserRole.MARKETING)
  @RequirePermission('plats', 'delete')
  @ApiOperation({ summary: "Suppression d'une relation entre plat et restaurant (via ID unique)" })
  remove(@Param('id') id: string) {
    return this.dishRestaurantService.remove(id);
  }

  @Delete('dish/:dishId/restaurant/:restaurantId')
  @UseGuards(JwtAuthGuard, UserTypesGuard, UserPermissionsGuard)
  @UserTypes(UserType.BACKOFFICE, UserType.RESTAURANT)
  @UserRoles(UserRole.ADMIN, UserRole.MARKETING)
  @RequirePermission('plats', 'delete')
  @ApiOperation({ summary: "Suppression d'une relation entre plat et restaurant (via dishId et restaurantId)" })
  removeByDishAndRestaurant(
    @Param('dishId') dishId: string,
    @Param('restaurantId') restaurantId: string,
  ) {
    return this.dishRestaurantService.removeByDishAndRestaurant(dishId, restaurantId);
  }
}
