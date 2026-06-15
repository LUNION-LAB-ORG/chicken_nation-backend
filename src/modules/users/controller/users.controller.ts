import { CacheInterceptor } from '@nestjs/cache-manager';
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { UserType } from '@prisma/client';
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
import type { Request } from 'express';
import { RequirePermission } from 'src/modules/auth/decorators/user-require-permission';
import { Action } from 'src/modules/auth/enums/action.enum';
import { Modules } from 'src/modules/auth/enums/module-enum';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import { UserPermissionsGuard } from 'src/modules/auth/guards/user-permissions.guard';
import { CreateUserDto } from 'src/modules/users/dto/create-user.dto';
import { UpdateUserPasswordDto } from 'src/modules/users/dto/update-user-password.dto';
import { UpdateUserDto } from 'src/modules/users/dto/update-user.dto';
import { UsersService } from 'src/modules/users/services/users.service';
import { ResetUserPasswordResponseDto } from '../dto/reset-user-password.dto';
import { RegisterUserExpoPushTokenDto } from '../dto/register-expo-push-token.dto';
import { S3Service } from 'src/s3/s3.service';
import { UserPushService } from '../services/user-push.service';

@Controller('users')
@UseInterceptors(CacheInterceptor)
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly s3service: S3Service,
    private readonly userPushService: UserPushService,
  ) {}

  // ============================================================
  // POST /users/me/expo-push-token (mobile staff — Chicken Nation Pro)
  // ============================================================
  @Post('me/expo-push-token')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary: "Enregistre/actualise le token Expo Push du staff connecté",
    description:
      'Appelé par l\'app mobile au login (et lors de chaque renouvellement). ' +
      'Permet ensuite au backend d\'envoyer des push notifications aux staffs ' +
      'du restaurant (ex: nouvelle commande).',
  })
  @ApiBody({ type: RegisterUserExpoPushTokenDto })
  @ApiOkResponse({ description: 'Token enregistré' })
  async registerExpoPushToken(
    @Req() req: Request,
    @Body() dto: RegisterUserExpoPushTokenDto,
  ) {
    const userId = (req.user as { id: string }).id;
    await this.userPushService.registerToken(userId, dto.token);
    return { ok: true };
  }

  private async uploadImage(image: Express.Multer.File) {
    if (!image) return null;
    return await this.s3service.uploadFile({
      buffer: image.buffer,
      path: 'chicken-nation/users-avatar',
      originalname: image.originalname,
      mimetype: image.mimetype,
    });
  }

  // CREATE USER
  @Post()
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.PERSONNELS, Action.CREATE)
  @UseInterceptors(FileInterceptor('image'))
  @ApiOperation({ summary: 'Création utilisateur' })
  @ApiCreatedResponse({
    description: 'Utilisateur créé avec succès',
  })
  @ApiBadRequestResponse({
    description: "Utilisateur déjà existant, changer d'email",
  })
  @ApiBody({ type: CreateUserDto })
  async create(
    @Req() req: Request,
    @Body() createUserDto: CreateUserDto,
    @UploadedFile() image: Express.Multer.File,
  ) {
    const result = await this.uploadImage(image);
    return this.usersService.create(req, {
      ...createUserDto,
      image: result?.key,
    });
  }

  // CREATE MEMBER
  @Post('member')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.PERSONNELS, Action.CREATE)
  @UseInterceptors(FileInterceptor('image'))
  @ApiOperation({ summary: 'Création membre' })
  @ApiCreatedResponse({
    description: 'Membre créé avec succès',
  })
  @ApiBadRequestResponse({
    description: "Membre déjà existant, changer d'email",
  })
  @ApiBody({ type: CreateUserDto })
  async createMember(
    @Req() req: Request,
    @Body() createUserDto: CreateUserDto,
    @UploadedFile() image: Express.Multer.File,
  ) {
    const result = await this.uploadImage(image);
    return this.usersService.createMember(req, {
      ...createUserDto,
      image: result?.key,
    });
  }

  // GET DETAIL USER
  @Get('detail')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.PERSONNELS, Action.READ)
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
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.PERSONNELS, Action.READ)
  @ApiOperation({ summary: 'Obtenir la liste des utilisateurs' })
  @ApiOkResponse({
    description: 'Liste des utilisateurs récupérée avec succès',
  })
  @ApiNotFoundResponse({
    description: 'Utilisateur non trouvé',
  })
  findAll(
    @Query('type') type?: UserType,
    @Query('restaurantId') restaurantId?: string,
  ) {
    return this.usersService.findAll({ type, restaurantId });
  }

  // UPDATE USER
  @Patch()
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileInterceptor('image'))
  @ApiOperation({ summary: 'Mise à jour utilisateur' })
  @ApiOkResponse({
    description: 'Utilisateur mis à jour avec succès',
  })
  @ApiBadRequestResponse({
    description: 'Utilisateur non trouvé',
  })
  @ApiBody({ type: UpdateUserDto })
  async update(
    @Req() req: Request,
    @Body() updateUserDto: UpdateUserDto,
    @UploadedFile() image: Express.Multer.File,
  ) {
    const result = await this.uploadImage(image);
    return this.usersService.update(req, {
      ...updateUserDto,
      image: result?.key,
    });
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
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.PERSONNELS, Action.UPDATE)
  @ApiOperation({ summary: 'Renouvellement mot de passe utilisateur' })
  @ApiOkResponse({
    description: 'Mot de passe mis à jour avec succès',
    type: ResetUserPasswordResponseDto,
  })
  @ApiBadRequestResponse({
    description: 'Utilisateur non trouvé',
  })
  async resetPassword(@Req() req: Request, @Param('id') user_id: string) {
    return this.usersService.resetPassword(req, user_id);
  }

  // UPDATE MEMBER (par id) — admin édite n'importe quel membre, ou soi-même.
  @Patch(':id')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.PERSONNELS, Action.UPDATE)
  @UseInterceptors(FileInterceptor('image'))
  @ApiOperation({ summary: 'Mise à jour d’un membre ciblé (admin)' })
  @ApiOkResponse({ description: 'Membre mis à jour avec succès' })
  @ApiBody({ type: UpdateUserDto })
  async updateById(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() updateUserDto: UpdateUserDto,
    @UploadedFile() image: Express.Multer.File,
  ) {
    const result = await this.uploadImage(image);
    return this.usersService.updateById(req, id, {
      ...updateUserDto,
      ...(result?.key ? { image: result.key } : {}),
    });
  }

  // PARTIAL DELETE
  @Delete()
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.PERSONNELS, Action.DELETE)
  @ApiOperation({ summary: 'Supprimer partiellement utilisateur' })
  @ApiOkResponse({
    description: 'Utilisateur supprimé partiellement avec succès',
  })
  @ApiUnauthorizedResponse({
    description: 'Utilisateur non trouvé',
  })
  async partialDelete(@Req() req: Request) {
    return this.usersService.partialRemove(req);
  }

  // INACTIVE
  @Post('inactive/:id')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.PERSONNELS, Action.UPDATE)
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
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.PERSONNELS, Action.UPDATE)
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

  // MANAGER PRINCIPAL
  @Patch(':id/set-principal-manager')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.PERSONNELS, Action.UPDATE)
  @ApiOperation({ summary: 'Définir un manager comme principal de son restaurant' })
  @ApiOkResponse({ description: 'Manager principal défini avec succès' })
  setPrincipalManager(@Req() req: Request, @Param('id') id: string) {
    return this.usersService.setPrincipalManager(req, id);
  }

  // DELETE
  @Delete('/delete/:id')
  @UseGuards(JwtAuthGuard, UserPermissionsGuard)
  @RequirePermission(Modules.PERSONNELS, Action.DELETE)
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
