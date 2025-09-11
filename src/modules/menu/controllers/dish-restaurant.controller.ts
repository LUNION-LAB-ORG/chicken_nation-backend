import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Delete,
  UseGuards,
} from '@nestjs/common';
import { DishRestaurantService } from 'src/modules/menu/services/dish-restaurant.service';
import { CreateDishRestaurantDto } from 'src/modules/menu/dto/create-dish-restaurant.dto';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserRole, UserType } from '@prisma/client';
import { UserTypesGuard } from 'src/common/guards/user-types.guard';
import { UserTypes } from 'src/common/decorators/user-types.decorator';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { UserRoles } from 'src/common/decorators/user-roles.decorator';
import { ModulePermissionsGuard } from 'src/common/guards/user-module-permissions-guard';
import { RequirePermission } from 'src/common/decorators/user-require-permission';


@ApiTags('Dish Restaurants')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, UserTypesGuard, ModulePermissionsGuard)
@Controller('dish-restaurants')
export class DishRestaurantController {
  constructor(
    private readonly dishRestaurantService: DishRestaurantService,
  ) {}

  @ApiOperation({ summary: "Création d'une nouvelle relation entre plat et restaurant" })
  @Post()
  @UserTypes(UserType.BACKOFFICE, UserType.RESTAURANT)
  @UserRoles(UserRole.ADMIN, UserRole.MARKETING)
  @RequirePermission('plats', 'create')
  create(@Body() createDishRestaurantDto: CreateDishRestaurantDto) {
    return this.dishRestaurantService.create(createDishRestaurantDto);
  }

  @ApiOperation({
    summary: 'Récupération de toutes les relations entre plats et restaurants',
  })
  @Get()
  @RequirePermission('plats', 'read')
  findAll() {
    return this.dishRestaurantService.findAll();
  }

  @ApiOperation({
    summary: "Suppression d'une relation entre plat et restaurant (via ID unique)",
  })
  @Delete(':id')
  @UserTypes(UserType.BACKOFFICE, UserType.RESTAURANT)
  @UserRoles(UserRole.ADMIN, UserRole.MARKETING)
  @RequirePermission('plats', 'delete')
  remove(@Param('id') id: string) {
    return this.dishRestaurantService.remove(id);
  }

  @ApiOperation({
    summary:
      "Suppression d'une relation entre plat et restaurant (via dishId et restaurantId)",
  })
  @Delete('dish/:dishId/restaurant/:restaurantId')
  @UserTypes(UserType.BACKOFFICE, UserType.RESTAURANT)
  @UserRoles(UserRole.ADMIN, UserRole.MARKETING)
  @RequirePermission('plats', 'delete')
  removeByDishAndRestaurant(
    @Param('dishId') dishId: string,
    @Param('restaurantId') restaurantId: string,
  ) {
    return this.dishRestaurantService.removeByDishAndRestaurant(
      dishId,
      restaurantId,
    );
  }
}
