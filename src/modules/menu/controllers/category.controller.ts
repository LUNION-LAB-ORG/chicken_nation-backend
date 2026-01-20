import { CacheInterceptor } from '@nestjs/cache-manager';
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Action } from 'src/modules/auth/enums/action.enum';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { CreateCategoryDto } from 'src/modules/menu/dto/create-category.dto';
import { UpdateCategoryDto } from 'src/modules/menu/dto/update-category.dto';
import { CategoryService } from 'src/modules/menu/services/category.service';

@ApiTags('Categories')
@ApiBearerAuth()
@Controller('categories')
@UseInterceptors(CacheInterceptor)
export class CategoryController {
  constructor(private readonly categoryService: CategoryService) {}

  @Post()
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.INVENTAIRE, Action.CREATE)
  @UseInterceptors(FileInterceptor('image'))
  @ApiOperation({ summary: "Création d'une nouvelle catégorie" })
  async create(
    @Req() req: Request,
    @Body() createCategoryDto: CreateCategoryDto,
    @UploadedFile() image: Express.Multer.File,
  ) {
    return this.categoryService.create(req, createCategoryDto, image);
  }

  @Get()
  @ApiOperation({ summary: 'Récupération de toutes les catégories' })
  findAll() {
    return this.categoryService.findAll();
  }

  @Get('/get-all')
  @ApiOperation({ summary: 'Récupération de toutes les catégories' })
  findAllBackoffice() {
    return this.categoryService.findAll({ all: true });
  }

  @Get(':id')
  @ApiOperation({ summary: "Récupération d'une catégorie par son id" })
  findOne(@Param('id') id: string) {
    return this.categoryService.findOne(id);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.INVENTAIRE, Action.UPDATE)
  @UseInterceptors(FileInterceptor('image'))
  @ApiOperation({ summary: "Mise à jour d'une catégorie par son id" })
  async update(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() updateCategoryDto: UpdateCategoryDto,
    @UploadedFile() image: Express.Multer.File,
  ) {
    return this.categoryService.update(req, id, updateCategoryDto, image);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.INVENTAIRE, Action.DELETE)
  @ApiOperation({ summary: "Suppression d'une catégorie par son id" })
  remove(@Param('id') id: string) {
    return this.categoryService.remove(id);
  }
}
