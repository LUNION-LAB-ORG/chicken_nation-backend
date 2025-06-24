import { Controller, Get, Post, Body, Req, UseGuards, Patch, Delete, Param, UseInterceptors, UploadedFile } from '@nestjs/common';
import { UsersService } from 'src/modules/users/services/users.service';
import { CreateUserDto } from 'src/modules/users/dto/create-user.dto';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiNotFoundResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Request } from 'express';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UpdateUserDto } from 'src/modules/users/dto/update-user.dto';
import { UpdateUserPasswordDto } from 'src/modules/users/dto/update-user-password.dto';
import { FileInterceptor } from '@nestjs/platform-express';
import { GenerateConfigService } from 'src/common/services/generate-config.service';

@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) { }

  // CREATE USER
  @ApiOperation({ summary: 'Création utilisateur' })
  @ApiCreatedResponse({
    description: 'Utilisateur créé avec succès',
  })
  @ApiBadRequestResponse({
    description: "Utilisateur déjà existant, changer d'email",
  })
  @ApiBody({ type: CreateUserDto })
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileInterceptor('image', { ...GenerateConfigService.generateConfigSingleImageUpload('./uploads/users-avatar') }))
  @Post()
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
  @ApiOperation({ summary: 'Création membre' })
  @ApiCreatedResponse({
    description: 'Membre créé avec succès',
  })
  @ApiBadRequestResponse({
    description: "Membre déjà existant, changer d'email",
  })
  @ApiBody({ type: CreateUserDto })
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileInterceptor('image', { ...GenerateConfigService.generateConfigSingleImageUpload('./uploads/users-avatar') }))
  @Post('member')
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
  @ApiOperation({ summary: "Obtenir les détails d'utilisateur" })
  @ApiOkResponse({
    description: 'Profil utilisateur récupéré avec succès',
  })
  @ApiNotFoundResponse({
    description: 'Utilisateur non trouvé',
  })
  @UseGuards(JwtAuthGuard)
  @Get('detail')
  detail(@Req() req: Request) {
    return this.usersService.detail(req);
  }

  // GET ALL USERS
  @ApiOperation({ summary: 'Obtenir la liste des utilisateurs' })
  @ApiOkResponse({
    description: 'Liste des utilisateurs récupérée avec succès',
  })
  @ApiNotFoundResponse({
    description: 'Utilisateur non trouvé',
  })
  @UseGuards(JwtAuthGuard)
  @Get()
  findAll() {
    return this.usersService.findAll();
  }

  // UPDATE USER
  @ApiOperation({ summary: 'Mise à jour utilisateur' })
  @ApiOkResponse({
    description: 'Utilisateur mis à jour avec succès',
  })
  @ApiBadRequestResponse({
    description: 'Utilisateur non trouvé',
  })
  @ApiBody({ type: UpdateUserDto })
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileInterceptor('image', { ...GenerateConfigService.generateConfigSingleImageUpload('./uploads/users-avatar') }))
  @Patch()
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
  @ApiOperation({ summary: 'Mise à jour mot de passe utilisateur' })
  @ApiOkResponse({
    description: 'Mot de passe mis à jour avec succès',
  })
  @ApiBadRequestResponse({
    description: 'Utilisateur non trouvé',
  })
  @ApiBody({ type: UpdateUserPasswordDto })
  @UseGuards(JwtAuthGuard)
  @Patch('password')
  async updatePassword(
    @Req() req: Request,
    @Body() updateUserPasswordDto: UpdateUserPasswordDto,
  ) {
    return this.usersService.updatePassword(req, updateUserPasswordDto);
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
  @ApiOperation({ summary: 'Inactiver utilisateur' })
  @ApiOkResponse({
    description: 'Utilisateur inactivé avec succès',
  })
  @ApiUnauthorizedResponse({
    description: 'Utilisateur non trouvé',
  })
  @UseGuards(JwtAuthGuard)
  @Post('inactive/:id')
  async inactive(@Req() req: Request, @Param('id') id: string) {
    return this.usersService.inactive(req, id);
  }

  // RESTAURATION 
  @ApiOperation({ summary: 'Restaurer utilisateur' })
  @ApiOkResponse({
    description: 'Utilisateur restauré avec succès',
  })
  @ApiUnauthorizedResponse({
    description: 'Utilisateur non trouvé',
  })
  @UseGuards(JwtAuthGuard)
  @Post('restore/:id')
  async restore(@Req() req: Request, @Param('id') id: string) {
    return this.usersService.restore(req, id);
  }


  // DELETE
  @ApiOperation({ summary: 'Supprimer définitivement utilisateur' })
  @ApiOkResponse({
    description: 'Utilisateur supprimé définitivement avec succès',
  })
  @ApiBadRequestResponse({
    description: 'Utilisateur non trouvé',
  })
  @UseGuards(JwtAuthGuard)
  @Delete('/delete/:id')
  async delete(@Req() req: Request, @Param('id') id: string) {
    return this.usersService.remove(req, id);
  }
}
