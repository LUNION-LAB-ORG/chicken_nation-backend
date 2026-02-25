import { CacheInterceptor } from '@nestjs/cache-manager';
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { GenerateConfigService } from 'src/common/services/generate-config.service';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Action } from 'src/modules/auth/enums/action.enum';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { DishRestaurantService } from 'src/modules/menu/services/dish-restaurant.service';
import { CreateRestaurantDto } from 'src/modules/restaurant/dto/create-restaurant.dto';
import { UpdateRestaurantDto } from 'src/modules/restaurant/dto/update-restaurant.dto';
import { RestaurantService } from 'src/modules/restaurant/services/restaurant.service';

@ApiTags('Restaurants')
@ApiBearerAuth()
@Controller('restaurants')
@UseInterceptors(CacheInterceptor)
export class RestaurantController {
  constructor(
    private readonly restaurantService: RestaurantService,
    private readonly dishRestaurantService: DishRestaurantService,
  ) { }

  @Post()
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.RESTAURANTS, Action.CREATE)
  @UseInterceptors(FileInterceptor('image'))
  async create(
    @Req() req: Request,
    @Body() createRestaurantDto: CreateRestaurantDto,
    @UploadedFile() image: Express.Multer.File,
  ) {
    return this.restaurantService.create(req, createRestaurantDto, image);
  }

  @Get()
  async findAll(@Query('page') page?: number, @Query('limit') limit?: number) {
    return this.restaurantService.findAll(page || 1, limit || 10);
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.restaurantService.findOne(id);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.RESTAURANTS, Action.UPDATE)
  @UseInterceptors(FileInterceptor('image'))
  async update(
    @Param('id') id: string,
    @Body() updateRestaurantDto: UpdateRestaurantDto,
    @UploadedFile() image: Express.Multer.File,
  ) {
    return this.restaurantService.update(id, updateRestaurantDto, image);
  }

  @Patch(':id/activateDeactivate')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.RESTAURANTS, Action.UPDATE)
  async activateDeactivate(@Param('id') id: string) {
    return this.restaurantService.activateDeactivate(id);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.RESTAURANTS, Action.DELETE)
  async remove(@Param('id') id: string) {
    return this.restaurantService.remove(id);
  }

  @Get(':id/users')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.PERSONNELS, Action.READ)
  async getRestaurantUsers(@Param('id') id: string) {
    return this.restaurantService.getRestaurantUsers(id);
  }

  @Get(':id/clients')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.CLIENTS, Action.READ)
  async getRestaurantCustomers(@Param('id') id: string) {
    return this.restaurantService.getRestaurantCustomers(id);
  }

  @Get(':id/manager')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.PERSONNELS, Action.READ)
  async getRestaurantManager(@Param('id') id: string) {
    return this.restaurantService.getRestaurantManager(id);
  }

  @Get(':restaurantId/dishes')
  @UseGuards(JwtAuthGuard)
  @RequirePermission(Modules.MENUS, Action.READ)
  async getAllDishesByRestaurant(@Param('restaurantId') restaurantId: string) {
    return this.dishRestaurantService.findByRestaurant(restaurantId);
  }

  @Get(':id/open')
  @UseGuards(JwtAuthGuard)
  @RequirePermission(Modules.RESTAURANTS, Action.READ)
  async isRestaurantOpen(
    @Param('id') id: string,
    @Query('date') date?: string,
  ) {
    const restaurant = await this.restaurantService.findOne(id);
    const schedule = JSON.parse(restaurant.schedule?.toString() ?? '[]');
    return this.restaurantService.isRestaurantOpen(
      schedule,
      date ? new Date(date) : new Date(),
    );
  }
}
