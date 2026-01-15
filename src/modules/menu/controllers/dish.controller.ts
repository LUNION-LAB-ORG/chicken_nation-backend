import { CacheInterceptor } from '@nestjs/cache-manager';
import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { GenerateConfigService } from 'src/common/services/generate-config.service';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Action } from 'src/modules/auth/enums/action.enum';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { CreateDishDto } from 'src/modules/menu/dto/create-dish.dto';
import { UpdateDishDto } from 'src/modules/menu/dto/update-dish.dto';
import { DishRestaurantService } from 'src/modules/menu/services/dish-restaurant.service';
import { DishService } from 'src/modules/menu/services/dish.service';
import { QueryDishDto } from '../dto/query-dish.dto';

@Controller('dishes')
@ApiTags('Dishes')
@ApiBearerAuth()
@UseInterceptors(CacheInterceptor)
export class DishController {
  constructor(private readonly dishService: DishService, private readonly dishRestaurantService: DishRestaurantService) { }

  @Post()
  @ApiOperation({ summary: 'Création d\'un plat' })
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.MENUS, Action.CREATE)
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

  @Get()
  @ApiOperation({ summary: 'Récupération de tous les plats' })
  findAll() {
    return this.dishService.findAll();
  }

  @Get("get-all")
  @ApiOperation({ summary: 'Récupération de tous les plats' })
  findAllBackoffice() {
    return this.dishService.findAll({ all: true });
  }

  @Get('search')
  @ApiOperation({ summary: 'Recherche de plats' })
  findMany(@Query() filter: QueryDishDto) {
    return this.dishService.findMany(filter);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtenir un plat par ID' })
  findOne(@Param('id') id: string) {
    return this.dishService.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Mettre à jour un plat' })
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.MENUS, Action.UPDATE)
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

  @Delete(':id')
  @ApiOperation({ summary: 'Supprimer un plat' })
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.MENUS, Action.DELETE)
  remove(@Param('id') id: string) {
    return this.dishService.remove(id);
  }


  @Get(':dishId/restaurants')
  @ApiOperation({ summary: 'Récupération de tous les restaurants liés à un plat' })
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.MENUS, Action.READ)
  getAllRestaurantsByDish(@Param('dishId') dishId: string) {
    return this.dishRestaurantService.findByDish(dishId);
  }

}