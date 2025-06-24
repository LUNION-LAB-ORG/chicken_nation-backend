import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards, UseInterceptors, UploadedFile, Req } from '@nestjs/common';
import { CategoryService } from 'src/modules/menu/services/category.service';
import { CreateCategoryDto } from 'src/modules/menu/dto/create-category.dto';
import { UpdateCategoryDto } from 'src/modules/menu/dto/update-category.dto';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserRolesGuard } from 'src/common/guards/user-roles.guard';
import { UserRoles } from 'src/common/decorators/user-roles.decorator';
import { UserRole, UserType } from '@prisma/client';
import { UserTypesGuard } from 'src/common/guards/user-types.guard';
import { UserTypes } from 'src/common/decorators/user-types.decorator';
import { FileInterceptor } from '@nestjs/platform-express';
import { GenerateConfigService } from 'src/common/services/generate-config.service';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Request } from 'express';

@ApiTags('Categories')
@ApiBearerAuth()
@Controller('categories')
export class CategoryController {
  constructor(private readonly categoryService: CategoryService) { }

  @ApiOperation({ summary: 'Création d\'une nouvelle catégorie' })
  @Post()
  @UseGuards(JwtAuthGuard, UserTypesGuard, UserRolesGuard)
  @UserTypes(UserType.BACKOFFICE)
  @UserRoles(UserRole.ADMIN, UserRole.MARKETING)
  @UseInterceptors(FileInterceptor('image', { ...GenerateConfigService.generateConfigSingleImageUpload('./uploads/categories') }))
  async create(@Req() req: Request, @Body() createCategoryDto: CreateCategoryDto, @UploadedFile() image: Express.Multer.File) {
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
    return this.categoryService.create(req, { ...createCategoryDto, image: resizedPath!["img_1"] ?? image?.path });
  }

  @ApiOperation({ summary: 'Récupération de toutes les catégories' })
  @Get()
  findAll() {
    return this.categoryService.findAll();
  }

  @ApiOperation({ summary: 'Récupération d\'une catégorie par son id' })
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.categoryService.findOne(id);
  }

  @ApiOperation({ summary: 'Mise à jour d\'une catégorie par son id' })
  @Patch(':id')
  @UseGuards(JwtAuthGuard, UserTypesGuard, UserRolesGuard)
  @UserTypes(UserType.BACKOFFICE)
  @UserRoles(UserRole.ADMIN, UserRole.MARKETING)
  @UseInterceptors(FileInterceptor('image', { ...GenerateConfigService.generateConfigSingleImageUpload('./uploads/categories') }))
  async update(@Req() req: Request, @Param('id') id: string, @Body() updateCategoryDto: UpdateCategoryDto, @UploadedFile() image: Express.Multer.File) {
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
    return this.categoryService.update(req, id, { ...updateCategoryDto, image: resizedPath!["img_1"] ?? image?.path });
  }

  @ApiOperation({ summary: 'Suppression d\'une catégorie par son id' })
  @Delete(':id')
  @UseGuards(JwtAuthGuard, UserTypesGuard, UserRolesGuard)
  @UserTypes(UserType.BACKOFFICE)
  @UserRoles(UserRole.ADMIN)
  remove(@Param('id') id: string) {
    return this.categoryService.remove(id);
  }
}