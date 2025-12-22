import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Request } from 'express';
import { UserRoles } from 'src/modules/auth/decorators/user-roles.decorator';
import { UserRolesGuard } from 'src/common/guards/user-roles.guard';
import { GenerateConfigService } from 'src/common/services/generate-config.service';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { CreateUserDto } from 'src/modules/users/dto/create-user.dto';
import { UpdateUserPasswordDto } from 'src/modules/users/dto/update-user-password.dto';
import { UpdateUserDto } from 'src/modules/users/dto/update-user.dto';
import { UsersService } from 'src/modules/users/services/users.service';
import { ResetUserPasswordResponseDto } from '../dto/reset-user-password.dto';
import { CacheInterceptor } from '@nestjs/cache-manager';

@Controller('users')
@UseInterceptors(CacheInterceptor)
export class UsersController {
  constructor(private readonly usersService: UsersService) { }

  // CREATE USER
  @Post()
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileInterceptor('image', { ...GenerateConfigService.generateConfigSingleImageUpload('./uploads/users-avatar') }))
  @ApiOperation({ summary: 'Création utilisateur' })
  @ApiCreatedResponse({
    description: 'Utilisateur créé avec succès',
  })
  @ApiBadRequestResponse({
    description: "Utilisateur déjà existant, changer d'email",
  })
  @ApiBody({ type: CreateUserDto })
  async create(@Req() req: Request, @Body() createUserDto: CreateUserDto, @UploadedFile() image: Express.Multer.File) {
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
    return this.usersService.create(req, { ...createUserDto, image: resizedPath!["img_1"] ?? image?.path });
  }

  // CREATE MEMBER
  @Post('member')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileInterceptor('image', { ...GenerateConfigService.generateConfigSingleImageUpload('./uploads/users-avatar') }))
  @ApiOperation({ summary: 'Création membre' })
  @ApiCreatedResponse({
    description: 'Membre créé avec succès',
  })
  @ApiBadRequestResponse({
    description: "Membre déjà existant, changer d'email",
  })
  @ApiBody({ type: CreateUserDto })
  async createMember(@Req() req: Request, @Body() createUserDto: CreateUserDto, @UploadedFile() image: Express.Multer.File) {

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

    return this.usersService.createMember(req, { ...createUserDto, image: resizedPath!["img_1"] ?? image?.path });
  }
  // GET DETAIL USER
  @Get('detail')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: "Obtenir les détails d'utilisateur" })
  @ApiOkResponse({
    description: 'Profil utilisateur récupéré avec succès',
  })
  @ApiNotFoundResponse({
    description: 'Utilisateur non trouvé',
  })
  detail(@Req() req: Request) {
    return this.usersService.detail(req);
  }

  // GET ALL USERS
  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Obtenir la liste des utilisateurs' })
  @ApiOkResponse({
    description: 'Liste des utilisateurs récupérée avec succès',
  })
  @ApiNotFoundResponse({
    description: 'Utilisateur non trouvé',
  })
  findAll() {
    return this.usersService.findAll();
  }

  // UPDATE USER
  @Patch()
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileInterceptor('image', { ...GenerateConfigService.generateConfigSingleImageUpload('./uploads/users-avatar') }))
  @ApiOperation({ summary: 'Mise à jour utilisateur' })
  @ApiOkResponse({
    description: 'Utilisateur mis à jour avec succès',
  })
  @ApiBadRequestResponse({
    description: 'Utilisateur non trouvé',
  })
  @ApiBody({ type: UpdateUserDto })
  async update(@Req() req: Request, @Body() updateUserDto: UpdateUserDto, @UploadedFile() image: Express.Multer.File) {
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
    return this.usersService.update(req, { ...updateUserDto, image: resizedPath!["img_1"] ?? image?.path });
  }

  // UPDATE PASSWORD
  @Patch('password')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Mise à jour mot de passe utilisateur' })
  @ApiOkResponse({
    description: 'Mot de passe mis à jour avec succès',
  })
  @ApiBadRequestResponse({
    description: 'Utilisateur non trouvé',
  })
  @ApiBody({ type: UpdateUserPasswordDto })
  async updatePassword(
    @Req() req: Request,
    @Body() updateUserPasswordDto: UpdateUserPasswordDto,
  ) {
    return this.usersService.updatePassword(req, updateUserPasswordDto);
  }
  // UPDATE PASSWORD
  @Patch(':id/reset-password')
  @UseGuards(JwtAuthGuard, UserRolesGuard)
  @UserRoles(UserRole.ADMIN, UserRole.MANAGER)
  @ApiOperation({ summary: 'Renouvellement mot de passe utilisateur' })
  @ApiOkResponse({
    description: 'Mot de passe mis à jour avec succès',
    type: ResetUserPasswordResponseDto,
  })
  @ApiBadRequestResponse({
    description: 'Utilisateur non trouvé',
  })
  async resetPassword(
    @Req() req: Request,
    @Param('id') user_id: string,
  ) {
    return this.usersService.resetPassword(req, user_id);
  }

  // PARTIAL DELETE
  @ApiOperation({ summary: 'Supprimer partiellement utilisateur' })
  @ApiOkResponse({
    description: 'Utilisateur supprimé partiellement avec succès',
  })
  @ApiUnauthorizedResponse({
    description: 'Utilisateur non trouvé',
  })
  @UseGuards(JwtAuthGuard)
  @Delete()
  async partialDelete(@Req() req: Request) {
    return this.usersService.partialRemove(req);
  }

  // INACTIVE
  @Post('inactive/:id')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Inactiver utilisateur' })
  @ApiOkResponse({
    description: 'Utilisateur inactivé avec succès',
  })
  @ApiUnauthorizedResponse({
    description: 'Utilisateur non trouvé',
  })
  async inactive(@Req() req: Request, @Param('id') id: string) {
    return this.usersService.inactive(req, id);
  }

  // RESTAURATION 
  @Post('restore/:id')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Restaurer utilisateur' })
  @ApiOkResponse({
    description: 'Utilisateur restauré avec succès',
  })
  @ApiUnauthorizedResponse({
    description: 'Utilisateur non trouvé',
  })
  async restore(@Req() req: Request, @Param('id') id: string) {
    return this.usersService.restore(req, id);
  }


  // DELETE
  @Delete('/delete/:id')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Supprimer définitivement utilisateur' })
  @ApiOkResponse({
    description: 'Utilisateur supprimé définitivement avec succès',
  })
  @ApiBadRequestResponse({
    description: 'Utilisateur non trouvé',
  })
  async delete(@Req() req: Request, @Param('id') id: string) {
    return this.usersService.remove(req, id);
  }

}
