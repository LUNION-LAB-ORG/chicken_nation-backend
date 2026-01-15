import { Body, Controller, Delete, Get, Param, Patch, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SupplementCategory } from '@prisma/client';
import { GenerateConfigService } from 'src/common/services/generate-config.service';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Action } from 'src/modules/auth/enums/action.enum';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { CreateSupplementDto } from 'src/modules/menu/dto/create-supplement.dto';
import { UpdateSupplementDto } from 'src/modules/menu/dto/update-supplement.dto';
import { SupplementService } from 'src/modules/menu/services/supplement.service';

@ApiTags('Supplements')
@ApiBearerAuth()
@Controller('supplements')
export class SupplementController {
  constructor(private readonly supplementService: SupplementService) { }

  @ApiOperation({ summary: 'Création d\'un supplément' })
  @Post()
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.INVENTAIRE, Action.CREATE)
  @UseInterceptors(FileInterceptor('image', { ...GenerateConfigService.generateConfigSingleImageUpload('./uploads/supplements') }))
  async create(@Body() createSupplementDto: CreateSupplementDto, @UploadedFile() image: Express.Multer.File) {
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
    return this.supplementService.create({ ...createSupplementDto, image: resizedPath!["img_1"] ?? image?.path });
  }

  @ApiOperation({ summary: 'Récupération de tous les suppléments' })
  @Get()
  findAll() {
    return this.supplementService.findAll();
  }

  @Get('category/:category')
  @ApiOperation({ summary: 'Récupération de tous les suppléments par catégorie' })
  findByCategory(@Param('category') category: SupplementCategory) {
    return this.supplementService.findByCategory(category);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Obtenir un supplément par ID' })
  findOne(@Param('id') id: string) {
    return this.supplementService.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Mettre à jour un supplément' })
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.INVENTAIRE, Action.UPDATE)
  @UseInterceptors(FileInterceptor('image', { ...GenerateConfigService.generateConfigSingleImageUpload('./uploads/supplements') }))
  async update(@Param('id') id: string, @Body() updateSupplementDto: UpdateSupplementDto, @UploadedFile() image: Express.Multer.File) {
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
    return this.supplementService.update(id, { ...updateSupplementDto, image: resizedPath!["img_1"] ?? image?.path });
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Supprimer un supplément' })
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.INVENTAIRE, Action.DELETE)
  remove(@Param('id') id: string) {
    return this.supplementService.remove(id);
  }
}