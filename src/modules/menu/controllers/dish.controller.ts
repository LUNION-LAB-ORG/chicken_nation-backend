import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards, UseInterceptors, UploadedFile } from '@nestjs/common';
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

@Controller('dishes')
export class DishController {
  constructor(private readonly dishService: DishService) { }

  @Post()
  @UseGuards(JwtAuthGuard, UserTypesGuard, UserRolesGuard)
  @UserTypes(UserType.BACKOFFICE)
  @UserRoles(UserRole.ADMIN)
  @UseInterceptors(FileInterceptor('image', { ...GenerateConfigService.generateConfigSingleImageUpload('./uploads/dishes', 'name') }))
  create(@Body() createDishDto: CreateDishDto, @UploadedFile() image: Express.Multer.File) {
    return this.dishService.create({ ...createDishDto, image: image.path });
  }

  @Get()
  findAll() {
    return this.dishService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.dishService.findOne(id);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, UserTypesGuard, UserRolesGuard)
  @UserTypes(UserType.BACKOFFICE)
  @UserRoles(UserRole.ADMIN)
  @UseInterceptors(FileInterceptor('image', { ...GenerateConfigService.generateConfigSingleImageUpload('./uploads/dishes', 'name') }))
  update(@Param('id') id: string, @Body() updateDishDto: UpdateDishDto, @UploadedFile() image: Express.Multer.File) {
    return this.dishService.update(id, { ...updateDishDto, image: image.path });
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, UserTypesGuard, UserRolesGuard)
  @UserTypes(UserType.BACKOFFICE)
  @UserRoles(UserRole.ADMIN)
  remove(@Param('id') id: string) {
    return this.dishService.remove(id);
  }
}