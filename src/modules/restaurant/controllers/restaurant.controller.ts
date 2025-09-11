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
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { UserRoles } from 'src/common/decorators/user-roles.decorator';
import { UserRolesGuard } from 'src/common/guards/user-roles.guard';
import { UserTypesGuard } from 'src/common/guards/user-types.guard';
import { UserTypes } from 'src/common/decorators/user-types.decorator';
import { FileInterceptor } from '@nestjs/platform-express';
import { GenerateConfigService } from 'src/common/services/generate-config.service';
import { DishRestaurantService } from 'src/modules/menu/services/dish-restaurant.service';
import { Request } from 'express';
import { ModulePermissionsGuard } from 'src/common/guards/user-module-permissions-guard';
import { RequirePermission } from 'src/common/decorators/user-require-permission';


@ApiTags('Restaurants')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, UserTypesGuard, ModulePermissionsGuard)
@Controller('restaurants')
export class RestaurantController {
  constructor(
    private readonly restaurantService: RestaurantService,
    private readonly dishRestaurantService: DishRestaurantService,
  ) {}

  @ApiOperation({ summary: "Création d'un restaurant avec son gestionnaire" })
  @Post()
  @UserTypes(UserType.BACKOFFICE)
  @UserRoles(UserRole.ADMIN)
  @RequirePermission('restaurants', 'create')
  @UseInterceptors(
    FileInterceptor('image', {
      ...GenerateConfigService.generateConfigSingleImageUpload(
        './uploads/restaurants',
      ),
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

  @ApiOperation({ summary: 'Obtenir tous les restaurants' })
  @Get()
  @RequirePermission('restaurants', 'read')
  async findAll(@Query('page') page?: number, @Query('limit') limit?: number) {
    return this.restaurantService.findAll(page || 1, limit || 10);
  }

  @ApiOperation({ summary: 'Obtenir un restaurant par ID' })
  @Get(':id')
  @RequirePermission('restaurants', 'read')
  async findOne(@Param('id') id: string) {
    return this.restaurantService.findOne(id);
  }

  @ApiOperation({ summary: 'Mettre à jour un restaurant' })
  @Patch(':id')
  @UserTypes(UserType.BACKOFFICE, UserType.RESTAURANT)
  @UserRoles(UserRole.ADMIN, UserRole.MANAGER)
  @RequirePermission('restaurants', 'update')
  @UseInterceptors(
    FileInterceptor('image', {
      ...GenerateConfigService.generateConfigSingleImageUpload(
        './uploads/restaurants',
      ),
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

  @ApiOperation({ summary: 'Activer/Désactiver un restaurant' })
  @Patch(':id/activateDeactivate')
  @UserTypes(UserType.BACKOFFICE, UserType.RESTAURANT)
  @UserRoles(UserRole.ADMIN, UserRole.MANAGER)
  @RequirePermission('restaurants', 'update')
  async activateDeactivate(@Param('id') id: string) {
    return this.restaurantService.activateDeactivate(id);
  }

  @ApiOperation({ summary: 'Supprimer un restaurant' })
  @Delete(':id')
  @UserTypes(UserType.BACKOFFICE)
  @UserRoles(UserRole.ADMIN)
  @RequirePermission('restaurants', 'delete')
  async remove(@Param('id') id: string) {
    return this.restaurantService.remove(id);
  }

  @ApiOperation({ summary: 'Obtenir tous les utilisateurs du restaurant' })
  @Get(':id/users')
  @UserTypes(UserType.BACKOFFICE, UserType.RESTAURANT)
  @UserRoles(UserRole.ADMIN, UserRole.MANAGER)
  @RequirePermission('restaurants', 'read')
  async getRestaurantUsers(@Param('id') id: string) {
    return this.restaurantService.getRestaurantUsers(id);
  }

  @ApiOperation({
    summary:
      'Obtenir tous les clients d’un restaurant qui ont déjà commandé',
  })
  @Get(':id/clients')
  @UserTypes(UserType.BACKOFFICE, UserType.RESTAURANT)
  @RequirePermission('clients', 'read')
  async getRestaurantCustomers(@Param('id') id: string) {
    return this.restaurantService.getRestaurantCustomers(id);
  }

  @ApiOperation({ summary: 'Obtenir le manager du restaurant' })
  @Get(':id/manager')
  @UserTypes(UserType.BACKOFFICE, UserType.RESTAURANT)
  @UserRoles(UserRole.ADMIN, UserRole.MANAGER)
  @RequirePermission('restaurants', 'read')
  async getRestaurantManager(@Param('id') id: string) {
    return this.restaurantService.getRestaurantManager(id);
  }

  @ApiOperation({ summary: 'Récupération des plats liés à un restaurant' })
  @Get(':restaurantId/dishes')
  @RequirePermission('plats', 'read')
  async getAllDishesByRestaurant(@Param('restaurantId') restaurantId: string) {
    return this.dishRestaurantService.findByRestaurant(restaurantId);
  }

  @ApiOperation({ summary: 'Vérifier si un restaurant est ouvert' })
  @Get(':id/open')
  @RequirePermission('restaurants', 'read')
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
