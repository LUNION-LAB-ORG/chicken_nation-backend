import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards, Query, UseInterceptors, Req } from '@nestjs/common';
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
import { FileInterceptor } from '@nestjs/platform-express';
import { GenerateConfigService } from 'src/common/services/generate-config.service';
import { UploadedFile } from '@nestjs/common';
import { DishRestaurantService } from 'src/modules/menu/services/dish-restaurant.service';
import { Request } from 'express';

@ApiTags('Restaurants')
@ApiBearerAuth()
@Controller('restaurants')
export class RestaurantController {
  constructor(private readonly restaurantService: RestaurantService, private readonly dishRestaurantService: DishRestaurantService) { }

  @ApiOperation({ summary: 'Création d\'un restaurant avec son gestionnaire' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, UserRolesGuard, UserTypesGuard)
  @UserRoles(UserRole.ADMIN)
  @UserTypes(UserType.BACKOFFICE)
  @Post()
  @UseInterceptors(FileInterceptor('image', { ...GenerateConfigService.generateConfigSingleImageUpload('./uploads/restaurants') }))
  async create(@Req() req: Request, @Body() createRestaurantDto: CreateRestaurantDto, @UploadedFile() image: Express.Multer.File) {
    const resizedPath = await GenerateConfigService.compressImages(
      { "img_1": image?.path },
      undefined,
      {
        quality: 70,
        width: 600,
        fit: 'inside',
      },
      true,
    );
    return this.restaurantService.create(req, { ...createRestaurantDto, image: resizedPath!["img_1"] ?? image?.path });
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
  @UseInterceptors(FileInterceptor('image', { ...GenerateConfigService.generateConfigSingleImageUpload('./uploads/restaurants') }))
  async update(
    @Param('id') id: string,
    @Body() updateRestaurantDto: UpdateRestaurantDto,
    @UploadedFile() image: Express.Multer.File,
  ) {
    const resizedPath = await GenerateConfigService.compressImages(
      { "img_1": image?.path },
      undefined,
      {
        quality: 70,
        width: 600,
        fit: 'inside',
      },
      true,
    );
    return this.restaurantService.update(id, { ...updateRestaurantDto, image: resizedPath!["img_1"] ?? image?.path });
  }

  @ApiOperation({ summary: 'Activer et Désactiver un restaurant' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, UserRolesGuard, UserTypesGuard)
  @UserRoles(UserRole.ADMIN, UserRole.MANAGER)
  @UserTypes(UserType.BACKOFFICE, UserType.RESTAURANT)
  @Patch(':id/activateDeactivate')
  async activateDeactivate(@Param('id') id: string) {
    return this.restaurantService.activateDeactivate(id);
  }

  @ApiOperation({ summary: 'Supprimer un restaurant' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, UserRolesGuard, UserTypesGuard)
  @UserRoles(UserRole.ADMIN)
  @UserTypes(UserType.BACKOFFICE)
  @Delete(':id')
  async remove(@Param('id') id: string) {
    return this.restaurantService.remove(id);
  }

  @ApiOperation({ summary: 'Obtenir tous les utilisateurs d un restaurant' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, UserRolesGuard, UserTypesGuard)
  @UserRoles(UserRole.ADMIN, UserRole.MANAGER)
  @UserTypes(UserType.BACKOFFICE, UserType.RESTAURANT)
  @Get(':id/users')
  async getRestaurantUsers(@Param('id') id: string) {
    return this.restaurantService.getRestaurantUsers(id);
  }

  @ApiOperation({ summary: 'Obtenir le manager d un restaurant' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, UserRolesGuard, UserTypesGuard)
  @UserRoles(UserRole.ADMIN, UserRole.MANAGER)
  @UserTypes(UserType.BACKOFFICE, UserType.RESTAURANT)
  @Get(':id/manager')
  async getRestaurantManager(@Param('id') id: string) {
    return this.restaurantService.getRestaurantManager(id);
  }



  @ApiOperation({ summary: 'Récupération de tous les plats liés à un restaurant' })
  @UseGuards(JwtAuthGuard)
  @Get(':restaurantId/dishes')
  async getAllDishesByRestaurant(@Param('restaurantId') restaurantId: string) {
    return this.dishRestaurantService.findByRestaurant(restaurantId);
  }

  @ApiOperation({ summary: 'Vérifier si un restaurant est ouvert' })
  @Get(':id/open')
  async isRestaurantOpen(@Param('id') id: string, @Query('date') date?: string) {
    const restaurant = await this.restaurantService.findOne(id);
    const schedule = JSON.parse(restaurant.schedule?.toString() ?? "[]");
    return this.restaurantService.isRestaurantOpen(schedule, date ? new Date(date) : new Date());
  }
}