import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards, UseInterceptors, UploadedFile, Req, Query } from '@nestjs/common';
import { DishService } from 'src/modules/menu/services/dish.service';
import { CreateDishDto } from 'src/modules/menu/dto/create-dish.dto';
import { UpdateDishDto } from 'src/modules/menu/dto/update-dish.dto';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserRolesGuard } from 'src/common/guards/user-roles.guard';
import { UserRoles } from 'src/common/decorators/user-roles.decorator';
import { UserRole, UserType } from '@prisma/client';
import { UserTypesGuard } from 'src/common/guards/user-types.guard';
import { UserTypes } from 'src/common/decorators/user-types.decorator';
import { FileInterceptor } from '@nestjs/platform-express';
import { GenerateConfigService } from 'src/common/services/generate-config.service';
import { ApiOperation, ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { DishRestaurantService } from 'src/modules/menu/services/dish-restaurant.service';
import { Request } from 'express';
import { QueryDishDto } from '../dto/query-dish.dto';

@Controller('dishes')
@ApiTags('Dishes')
@ApiBearerAuth()
export class DishController {
  constructor(private readonly dishService: DishService, private readonly dishRestaurantService: DishRestaurantService) { }

  @ApiOperation({ summary: 'Création d\'un plat' })
  @Post()
  @UseGuards(JwtAuthGuard, UserTypesGuard, UserRolesGuard)
  @UserTypes(UserType.BACKOFFICE)
  @UserRoles(UserRole.ADMIN, UserRole.MARKETING)
  @UseInterceptors(FileInterceptor('image', { ...GenerateConfigService.generateConfigSingleImageUpload('./uploads/dishes') }))
  async create(@Req() req: Request, @Body() createDishDto: CreateDishDto, @UploadedFile() image: Express.Multer.File) {
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
    return this.dishService.create(req, { ...createDishDto, image: resizedPath!["img_1"] ?? image?.path });
  }

  @ApiOperation({ summary: 'Récupération de tous les plats' })
  @Get()
  findAll() {
    return this.dishService.findAll();
  }
  @ApiOperation({ summary: 'Recherche de plats' })
  @Get('search')
  findMany(@Query() filter: QueryDishDto) {
    return this.dishService.findMany(filter);
  }

  @ApiOperation({ summary: 'Obtenir un plat par ID' })
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.dishService.findOne(id);
  }

  @ApiOperation({ summary: 'Mettre à jour un plat' })
  @Patch(':id')
  @UseGuards(JwtAuthGuard, UserTypesGuard, UserRolesGuard)
  @UserTypes(UserType.BACKOFFICE)
  @UserRoles(UserRole.ADMIN, UserRole.MARKETING)
  @UseInterceptors(FileInterceptor('image', { ...GenerateConfigService.generateConfigSingleImageUpload('./uploads/dishes') }))
  async update(@Req() req: Request, @Param('id') id: string, @Body() updateDishDto: UpdateDishDto, @UploadedFile() image: Express.Multer.File) {
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
    return this.dishService.update(req, id, { ...updateDishDto, image: resizedPath!["img_1"] ?? image?.path });
  }

  @ApiOperation({ summary: 'Supprimer un plat' })
  @Delete(':id')
  @UseGuards(JwtAuthGuard, UserTypesGuard, UserRolesGuard)
  @UserTypes(UserType.BACKOFFICE)
  @UserRoles(UserRole.ADMIN)
  remove(@Param('id') id: string) {
    return this.dishService.remove(id);
  }


  @ApiOperation({ summary: 'Récupération de tous les restaurants liés à un plat' })
  @Get(':dishId/restaurants')
  @UseGuards(JwtAuthGuard, UserTypesGuard, UserRolesGuard)
  @UserTypes(UserType.BACKOFFICE, UserType.RESTAURANT)
  @UserRoles(UserRole.ADMIN, UserRole.MANAGER)
  getAllRestaurantsByDish(@Param('dishId') dishId: string) {

    return this.dishRestaurantService.findByDish(dishId);
  }

}