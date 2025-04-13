import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards, Query } from '@nestjs/common';
import { SupplementService } from 'src/modules/menu/services/supplement.service';
import { CreateSupplementDto } from 'src/modules/menu/dto/create-supplement.dto';
import { UpdateSupplementDto } from 'src/modules/menu/dto/update-supplement.dto';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserRolesGuard } from 'src/common/guards/user-roles.guard';
import { UserRoles } from 'src/common/decorators/user-roles.decorator';
import { SupplementCategory, UserRole, UserType } from '@prisma/client';
import { UserTypesGuard } from 'src/common/guards/user-types.guard';
import { UserTypes } from 'src/common/decorators/user-types.decorator';

@Controller('supplements')
export class SupplementController {
  constructor(private readonly supplementService: SupplementService) { }

  @Post()
  @UseGuards(JwtAuthGuard, UserTypesGuard, UserRolesGuard)
  @UserTypes(UserType.BACKOFFICE)
  @UserRoles(UserRole.ADMIN)
  create(@Body() createSupplementDto: CreateSupplementDto) {
    return this.supplementService.create(createSupplementDto);
  }

  @Get()
  findAll() {
    return this.supplementService.findAll();
  }

  @Get('category/:category')
  findByCategory(@Param('category') category: SupplementCategory) {
    return this.supplementService.findByCategory(category);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.supplementService.findOne(id);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, UserTypesGuard, UserRolesGuard)
  @UserTypes(UserType.BACKOFFICE)
  @UserRoles(UserRole.ADMIN)
  update(@Param('id') id: string, @Body() updateSupplementDto: UpdateSupplementDto) {
    return this.supplementService.update(id, updateSupplementDto);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, UserTypesGuard, UserRolesGuard)
  @UserTypes(UserType.BACKOFFICE)
  @UserRoles(UserRole.ADMIN)
  remove(@Param('id') id: string) {
    return this.supplementService.remove(id);
  }
}