import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Patch,
  Delete,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  Req,
} from '@nestjs/common';
import { CategoryService } from 'src/modules/menu/services/category.service';
import { CreateCategoryDto } from 'src/modules/menu/dto/create-category.dto';
import { UpdateCategoryDto } from 'src/modules/menu/dto/update-category.dto';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserRole, UserType } from '@prisma/client';
import { UserTypesGuard } from 'src/common/guards/user-types.guard';
import { UserTypes } from 'src/modules/auth/decorators/user-types.decorator';
import { FileInterceptor } from '@nestjs/platform-express';
import { GenerateConfigService } from 'src/common/services/generate-config.service';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Request } from 'express';
import { UserRoles } from 'src/modules/auth/decorators/user-roles.decorator';
import { UserPermissionsGuard } from 'src/common/guards/user-permissions.guard';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { Action } from 'src/common/enum/action.enum';
import { CacheInterceptor } from '@nestjs/cache-manager';

@ApiTags('Categories')
@ApiBearerAuth()
@Controller('categories')
@UseInterceptors(CacheInterceptor)
export class CategoryController {
  constructor(private readonly categoryService: CategoryService) { }

  @Post()
  @UseGuards(JwtAuthGuard, UserTypesGuard, UserPermissionsGuard)
  @UserTypes(UserType.BACKOFFICE)
  @UserRoles(UserRole.ADMIN, UserRole.MARKETING)
  @RequirePermission(Modules.INVENTAIRE, Action.CREATE)
  @UseInterceptors(
    FileInterceptor('image', GenerateConfigService.generateConfigSingleImageUpload('./uploads/categories')),
  )
  @ApiOperation({ summary: "Création d'une nouvelle catégorie" })
  async create(
    @Req() req: Request,
    @Body() createCategoryDto: CreateCategoryDto,
    @UploadedFile() image: Express.Multer.File,
  ) {
    const resizedPath = await GenerateConfigService.compressImages(
      { img_1: image?.path },
      undefined,
      { quality: 70, width: 600, fit: 'inside' },
      true,
    );
    return this.categoryService.create(req, {
      ...createCategoryDto,
      image: resizedPath?.['img_1'] ?? image?.path,
    });
  }

  @Get()
  @ApiOperation({ summary: 'Récupération de toutes les catégories' })
  findAll() {
    return this.categoryService.findAll();
  }

  @Get("/get-all")
  @ApiOperation({ summary: 'Récupération de toutes les catégories' })
  findAllBackoffice() {
    return this.categoryService.findAll({ all: true });
  }

  @Get(':id')
  @UseGuards(UserPermissionsGuard)
  @ApiOperation({ summary: "Récupération d'une catégorie par son id" })
  findOne(@Param('id') id: string) {
    return this.categoryService.findOne(id);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, UserTypesGuard, UserPermissionsGuard)
  @UserTypes(UserType.BACKOFFICE)
  @UserRoles(UserRole.ADMIN, UserRole.MARKETING)
  @RequirePermission(Modules.INVENTAIRE, Action.UPDATE)
  @UseInterceptors(
    FileInterceptor('image', GenerateConfigService.generateConfigSingleImageUpload('./uploads/categories')),
  )
  @ApiOperation({ summary: "Mise à jour d'une catégorie par son id" })
  async update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() updateCategoryDto: UpdateCategoryDto,
    @UploadedFile() image: Express.Multer.File,
  ) {
    const resizedPath = await GenerateConfigService.compressImages(
      { img_1: image?.path },
      undefined,
      { quality: 70, width: 600, fit: 'inside' },
      true,
    );
    return this.categoryService.update(req, id, {
      ...updateCategoryDto,
      image: resizedPath?.['img_1'] ?? image?.path,
    });
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, UserTypesGuard, UserPermissionsGuard)
  @UserTypes(UserType.BACKOFFICE)
  @UserRoles(UserRole.ADMIN, UserRole.MARKETING)
  @RequirePermission(Modules.INVENTAIRE, Action.DELETE)
  @ApiOperation({ summary: "Suppression d'une catégorie par son id" })
  remove(@Param('id') id: string) {
    return this.categoryService.remove(id);
  }
}
