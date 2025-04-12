import { Controller, Get, Post, Body, Req, UseGuards, Patch, Delete, Param } from '@nestjs/common';
import { UsersService } from 'src/modules/users/service/users.service';
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
  @Post()
  create(@Body() createUserDto: CreateUserDto) {
    return this.usersService.create(createUserDto);
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
  @Post('member')
  createMember(@Body() createUserDto: CreateUserDto) {
    return this.usersService.createMember(createUserDto);
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
  @Patch()
  update(@Req() req: Request, @Body() updateUserDto: UpdateUserDto) {
    return this.usersService.update(req, updateUserDto);
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
  updatePassword(
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
