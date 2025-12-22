import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  Query,
  UseInterceptors,
  Req,
  UploadedFile,
} from '@nestjs/common';
import { RestaurantService } from 'src/modules/restaurant/services/restaurant.service';
import { CreateRestaurantDto } from 'src/modules/restaurant/dto/create-restaurant.dto';
import { UpdateRestaurantDto } from 'src/modules/restaurant/dto/update-restaurant.dto';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserRole, UserType } from '@prisma/client';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { UserRoles } from 'src/modules/auth/decorators/user-roles.decorator';
import { UserTypesGuard } from 'src/common/guards/user-types.guard';
import { UserTypes } from 'src/modules/auth/decorators/user-types.decorator';
import { FileInterceptor } from '@nestjs/platform-express';
import { GenerateConfigService } from 'src/common/services/generate-config.service';
import { DishRestaurantService } from 'src/modules/menu/services/dish-restaurant.service';
import { Request } from 'express';
import { UserPermissionsGuard } from 'src/common/guards/user-permissions.guard';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { Action } from 'src/common/enum/action.enum';
import { CacheInterceptor } from '@nestjs/cache-manager';

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
  @UseGuards(JwtAuthGuard, UserTypesGuard, UserPermissionsGuard)
  @UserTypes(UserType.BACKOFFICE)
  @UserRoles(UserRole.ADMIN)
  @RequirePermission(Modules.RESTAURANTS, Action.CREATE)
  @UseInterceptors(
    FileInterceptor('image', {
      ...GenerateConfigService.generateConfigSingleImageUpload('./uploads/restaurants'),
    }),
  )
  async create(
    @Req() req: Request,
    @Body() createRestaurantDto: CreateRestaurantDto,
    @UploadedFile() image: Express.Multer.File,
  ) {
    const resizedPath = await GenerateConfigService.compressImages(
      { img_1: image?.path },
      undefined,
      { quality: 70, width: 600, fit: 'inside' },
      true,
    );
    return this.restaurantService.create(req, {
      ...createRestaurantDto,
      image: resizedPath!['img_1'] ?? image?.path,
    });
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
  @UseGuards(JwtAuthGuard, UserTypesGuard, UserPermissionsGuard)
  @UserTypes(UserType.BACKOFFICE, UserType.RESTAURANT)
  @UserRoles(UserRole.ADMIN, UserRole.MANAGER)
  @RequirePermission(Modules.RESTAURANTS, Action.UPDATE)
  @UseInterceptors(
    FileInterceptor('image', {
      ...GenerateConfigService.generateConfigSingleImageUpload('./uploads/restaurants'),
    }),
  )
  async update(
    @Param('id') id: string,
    @Body() updateRestaurantDto: UpdateRestaurantDto,
    @UploadedFile() image: Express.Multer.File,
  ) {
    const resizedPath = await GenerateConfigService.compressImages(
      { img_1: image?.path },
      undefined,
      { quality: 70, width: 600, fit: 'inside' },
      true,
    );
    return this.restaurantService.update(id, {
      ...updateRestaurantDto,
      image: resizedPath!['img_1'] ?? image?.path,
    });
  }

  @Patch(':id/activateDeactivate')
  @UseGuards(JwtAuthGuard, UserTypesGuard, UserPermissionsGuard)
  @UserTypes(UserType.BACKOFFICE, UserType.RESTAURANT)
  @UserRoles(UserRole.ADMIN, UserRole.MANAGER)
  @RequirePermission(Modules.RESTAURANTS, Action.UPDATE)
  async activateDeactivate(@Param('id') id: string) {
    return this.restaurantService.activateDeactivate(id);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, UserTypesGuard, UserPermissionsGuard)
  @UserTypes(UserType.BACKOFFICE)
  @UserRoles(UserRole.ADMIN)
  @RequirePermission(Modules.RESTAURANTS, Action.DELETE)
  async remove(@Param('id') id: string) {
    return this.restaurantService.remove(id);
  }

  @Get(':id/users')
  @UseGuards(JwtAuthGuard, UserTypesGuard, UserPermissionsGuard)
  @UserTypes(UserType.BACKOFFICE, UserType.RESTAURANT)
  @UserRoles(UserRole.ADMIN, UserRole.MANAGER)
  @RequirePermission(Modules.RESTAURANTS, Action.READ)
  async getRestaurantUsers(@Param('id') id: string) {
    return this.restaurantService.getRestaurantUsers(id);
  }

  // 🔹 Endpoint client, garde JwtCustomerAuthGuard ou JwtAuthGuard
  @Get(':id/clients')
  @UseGuards(JwtAuthGuard) // pas de UserPermissionsGuard
  async getRestaurantCustomers(@Param('id') id: string) {
    return this.restaurantService.getRestaurantCustomers(id);
  }

  @Get(':id/manager')
  @UseGuards(JwtAuthGuard, UserTypesGuard, UserPermissionsGuard)
  @UserTypes(UserType.BACKOFFICE, UserType.RESTAURANT)
  @UserRoles(UserRole.ADMIN, UserRole.MANAGER)
  @RequirePermission(Modules.RESTAURANTS, Action.READ)
  async getRestaurantManager(@Param('id') id: string) {
    return this.restaurantService.getRestaurantManager(id);
  }

  @Get(':restaurantId/dishes')
  @UseGuards(JwtAuthGuard) // endpoint client
  @RequirePermission(Modules.PLATS, Action.READ)
  async getAllDishesByRestaurant(@Param('restaurantId') restaurantId: string) {
    return this.dishRestaurantService.findByRestaurant(restaurantId);
  }

  @Get(':id/open')
  @UseGuards(JwtAuthGuard) // endpoint client
  @RequirePermission(Modules.RESTAURANTS, Action.CREATE)
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
