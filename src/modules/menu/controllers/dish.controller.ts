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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Customer } from '@prisma/client';
import type { Request } from 'express';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Action } from 'src/modules/auth/enums/action.enum';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { JwtCustomerOptionalAuthGuard } from 'src/modules/auth/guards/jwt-customer-optional-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { CreateDishDto } from 'src/modules/menu/dto/create-dish.dto';
import { UpdateDishDto } from 'src/modules/menu/dto/update-dish.dto';
import { DishService } from 'src/modules/menu/services/dish.service';
import { QueryDishDto } from '../dto/query-dish.dto';

@Controller('dishes')
@ApiTags('Dishes')
@ApiBearerAuth()
// ⚠️ PAS de CacheInterceptor global ici : les listes de plats sont filtrées par
// l'audience du CLIENT connecté → un cache par URL servirait la liste d'un client
// à un autre (fuite inter-clients). Le filtrage est per-request.
export class DishController {
  constructor(
    private readonly dishService: DishService,
  ) { }

  @Post()
  @ApiOperation({ summary: "Création d'un plat" })
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.MENUS, Action.CREATE)
  @UseInterceptors(FileInterceptor('image'))
  async create(
    @Req() req: Request,
    @Body() createDishDto: CreateDishDto,
    @UploadedFile() image: Express.Multer.File,
  ) {
    return this.dishService.create(req, createDishDto, image);
  }

  @Get()
  @ApiOperation({ summary: 'Récupération des plats (filtrés par audience du client connecté)' })
  @UseGuards(JwtCustomerOptionalAuthGuard)
  findAll(@Req() req: Request) {
    return this.dishService.findAll(undefined, req.user as Customer | undefined);
  }

  @Get('get-all')
  @ApiOperation({ summary: 'Récupération de tous les plats (backoffice, sans filtre audience)' })
  findAllBackoffice() {
    return this.dishService.findAll({ all: true });
  }

  @Get('search')
  @ApiOperation({ summary: 'Recherche de plats (filtrés par audience du client connecté)' })
  @UseGuards(JwtCustomerOptionalAuthGuard)
  findMany(@Query() filter: QueryDishDto, @Req() req: Request) {
    return this.dishService.findMany(filter, req.user as Customer | undefined);
  }

  @Get('popular')
  @ApiOperation({ summary: 'Plats populaires (filtrés par audience du client connecté)' })
  @UseGuards(JwtCustomerOptionalAuthGuard)
  async getPopularDishes(
    @Req() req: Request,
    @Query('days') days?: string,
    @Query('limit') limit?: string,
  ) {
    const parsedDays = days ? parseInt(days, 10) : 30;
    const parsedLimit = limit ? parseInt(limit, 10) : 4;

    return this.dishService.findPopular(
      parsedDays,
      parsedLimit,
      req.user as Customer | undefined,
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtenir un plat par ID' })
  findOne(@Param('id') id: string, @Query() query?: { customerId?: string }) {
    return this.dishService.findOne(id, query?.customerId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Mettre à jour un plat' })
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.MENUS, Action.UPDATE)
  @UseInterceptors(FileInterceptor('image'))
  async update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() updateDishDto: UpdateDishDto,
    @UploadedFile() image: Express.Multer.File,
  ) {
    return this.dishService.update(req, id, updateDishDto, image);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Supprimer un plat' })
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.MENUS, Action.DELETE)
  remove(@Param('id') id: string) {
    return this.dishService.remove(id);
  }

}