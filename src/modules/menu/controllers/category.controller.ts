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
import { UserTypes } from 'src/common/decorators/user-types.decorator';
import { FileInterceptor } from '@nestjs/platform-express';
import { GenerateConfigService } from 'src/common/services/generate-config.service';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Request } from 'express';
import { UserRoles } from 'src/common/decorators/user-roles.decorator';
import { PermissionsGuard } from 'src/common/guards/user-module-permissions-guard';
import { RequirePermission } from 'src/common/decorators/user-require-permission';

@ApiTags('Categories')
@ApiBearerAuth()
@Controller('categories')
export class CategoryController {
  constructor(private readonly categoryService: CategoryService) {}

  @Post()
  @UseGuards(JwtAuthGuard, UserTypesGuard, PermissionsGuard)
  @UserTypes(UserType.BACKOFFICE)
  @UserRoles(UserRole.ADMIN, UserRole.MARKETING)
  @RequirePermission('categories', 'create')
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
  @UseGuards(PermissionsGuard)
  @RequirePermission('categories', 'read')
  @ApiOperation({ summary: 'Récupération de toutes les catégories' })
  findAll() {
    return this.categoryService.findAll();
  }

  @Get(':id')
  @UseGuards(PermissionsGuard)
  @RequirePermission('categories', 'read')
  @ApiOperation({ summary: "Récupération d'une catégorie par son id" })
  findOne(@Param('id') id: string) {
    return this.categoryService.findOne(id);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, UserTypesGuard, PermissionsGuard)
  @UserTypes(UserType.BACKOFFICE)
  @UserRoles(UserRole.ADMIN, UserRole.MARKETING)
  @RequirePermission('categories', 'update')
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
  @UseGuards(JwtAuthGuard, UserTypesGuard, PermissionsGuard)
  @UserTypes(UserType.BACKOFFICE)
  @UserRoles(UserRole.ADMIN, UserRole.MARKETING)
  @RequirePermission('categories', 'delete')
  @ApiOperation({ summary: "Suppression d'une catégorie par son id" })
  remove(@Param('id') id: string) {
    return this.categoryService.remove(id);
  }
}
