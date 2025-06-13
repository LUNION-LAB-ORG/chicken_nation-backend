import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards, UseInterceptors, UploadedFile } from '@nestjs/common';
import { SupplementService } from 'src/modules/menu/services/supplement.service';
import { CreateSupplementDto } from 'src/modules/menu/dto/create-supplement.dto';
import { UpdateSupplementDto } from 'src/modules/menu/dto/update-supplement.dto';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserRolesGuard } from 'src/common/guards/user-roles.guard';
import { UserRoles } from 'src/common/decorators/user-roles.decorator';
import { SupplementCategory, UserRole, UserType } from '@prisma/client';
import { UserTypesGuard } from 'src/common/guards/user-types.guard';
import { UserTypes } from 'src/common/decorators/user-types.decorator';
import { GenerateConfigService } from 'src/common/services/generate-config.service';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiOperation, ApiTags, ApiBearerAuth } from '@nestjs/swagger';

@ApiTags('Supplements')
@ApiBearerAuth()
@Controller('supplements')
export class SupplementController {
  constructor(private readonly supplementService: SupplementService) { }

  @ApiOperation({ summary: 'Création d\'un supplément' })
  @Post()
  @UseGuards(JwtAuthGuard, UserTypesGuard, UserRolesGuard)
  @UserTypes(UserType.BACKOFFICE)
  @UserRoles(UserRole.ADMIN)
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

  @ApiOperation({ summary: 'Récupération de tous les suppléments par catégorie' })
  @Get('category/:category')
  findByCategory(@Param('category') category: SupplementCategory) {
    return this.supplementService.findByCategory(category);
  }

  @ApiOperation({ summary: 'Obtenir un supplément par ID' })
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.supplementService.findOne(id);
  }

  @ApiOperation({ summary: 'Mettre à jour un supplément' })
  @Patch(':id')
  @UseGuards(JwtAuthGuard, UserTypesGuard, UserRolesGuard)
  @UserTypes(UserType.BACKOFFICE)
  @UserRoles(UserRole.ADMIN)
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

  @ApiOperation({ summary: 'Supprimer un supplément' })
  @Delete(':id')
  @UseGuards(JwtAuthGuard, UserTypesGuard, UserRolesGuard)
  @UserTypes(UserType.BACKOFFICE)
  @UserRoles(UserRole.ADMIN)
  remove(@Param('id') id: string) {
    return this.supplementService.remove(id);
  }
}