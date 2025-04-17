import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards, Req } from '@nestjs/common';
import { FavoriteService } from 'src/modules/customer/services/favorite.service';
import { CreateFavoriteDto } from 'src/modules/customer/dto/create-favorite.dto';
import { UpdateFavoriteDto } from 'src/modules/customer/dto/update-favorite.dto';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserType } from '@prisma/client';
import { Request } from 'express';
import { UserTypesGuard } from 'src/common/guards/user-types.guard';
import { UserTypes } from 'src/common/decorators/user-types.decorator';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';

@ApiTags('Favorites')
@ApiBearerAuth()
@Controller('favorites')
export class FavoriteController {
  constructor(private readonly favoriteService: FavoriteService) {}

  @ApiOperation({ summary: 'Création d\'une nouvelle favorite' })
  @UseGuards(JwtAuthGuard, UserTypesGuard)
  @UserTypes(UserType.CUSTOMER)
  @Post()
  create(@Req() req: Request, @Body() createFavoriteDto: CreateFavoriteDto) {
    return this.favoriteService.create(req, createFavoriteDto);
  }

  @ApiOperation({ summary: 'Récupération de toutes les favorites' })
  @Get()
  findAll() {
    return this.favoriteService.findAll();
  }

  @ApiOperation({ summary: 'Obtenir une favorite par ID' })
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.favoriteService.findOne(id);
  }

  @ApiOperation({ summary: 'Obtenir toutes les favorites d un client' })
  @Get('customer/:customerId')
  findByCustomer(@Param('customerId') customerId: string) {
    return this.favoriteService.findByCustomer(customerId);
  }

  @ApiOperation({ summary: 'Mettre à jour une favorite' })
  @UseGuards(JwtAuthGuard, UserTypesGuard)
  @UserTypes(UserType.CUSTOMER)
  @Patch(':id')
  update(@Param('id') id: string, @Body() updateFavoriteDto: UpdateFavoriteDto) {
    return this.favoriteService.update(id, updateFavoriteDto);
  }

  @ApiOperation({ summary: 'Supprimer une favorite' })
  @UseGuards(JwtAuthGuard, UserTypesGuard)
  @UserTypes(UserType.CUSTOMER)
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.favoriteService.remove(id);
  }

  @ApiOperation({ summary: 'Supprimer une favorite par client et plat' })
  @Delete('customer/:customerId/dish/:dishId')
  removeByCustomerAndDish(
    @Param('customerId') customerId: string,
    @Param('dishId') dishId: string,
  ) {
    return this.favoriteService.removeByCustomerAndDish(customerId, dishId);
  }
}