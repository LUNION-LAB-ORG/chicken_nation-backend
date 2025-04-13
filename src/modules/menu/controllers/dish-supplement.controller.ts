import { Controller, Get, Post, Body, Param, Delete, UseGuards } from '@nestjs/common';
import { DishSupplementService } from 'src/modules/menu/services/dish-supplement.service';
import { CreateDishSupplementDto } from 'src/modules/menu/dto/create-dish-supplement.dto';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserRolesGuard } from 'src/common/guards/user-roles.guard';
import { UserRoles } from 'src/common/decorators/user-roles.decorator';
import { UserRole, UserType } from '@prisma/client';
import { UserTypesGuard } from 'src/common/guards/user-types.guard';
import { UserTypes } from 'src/common/decorators/user-types.decorator';

@Controller('dish-supplements')
export class DishSupplementController {
  constructor(private readonly dishSupplementService: DishSupplementService) { }

  @Post()
  @UseGuards(JwtAuthGuard, UserTypesGuard, UserRolesGuard)
  @UserTypes(UserType.BACKOFFICE, UserType.RESTAURANT)
  @UserRoles(UserRole.ADMIN, UserRole.MANAGER)
  create(@Body() createDishSupplementDto: CreateDishSupplementDto) {
    return this.dishSupplementService.create(createDishSupplementDto);
  }

  @Get()
  findAll() {
    return this.dishSupplementService.findAll();
  }

  @Get('dish/:dishId')
  findByDish(@Param('dishId') dishId: string) {
    return this.dishSupplementService.findByDish(dishId);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, UserRolesGuard)
  @UserRoles(UserRole.ADMIN, UserRole.MANAGER)
  remove(@Param('id') id: string) {
    return this.dishSupplementService.remove(id);
  }

  @Delete('dish/:dishId/supplement/:supplementId')
  @UseGuards(JwtAuthGuard, UserTypesGuard, UserRolesGuard)
  @UserTypes(UserType.BACKOFFICE)
  @UserRoles(UserRole.ADMIN)
  removeByDishAndSupplement(
    @Param('dishId') dishId: string,
    @Param('supplementId') supplementId: string,
  ) {
    return this.dishSupplementService.removeByDishAndSupplement(dishId, supplementId);
  }
}