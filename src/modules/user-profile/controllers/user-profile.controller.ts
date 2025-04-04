import { Controller, Get, Put, Delete, UseGuards, Request, Body, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { UserProfileService } from '../services/user-profile.service';
import { UpdateProfileDto } from '../dto/update-profile.dto';

@ApiTags('user-profile')
@Controller('user-profile')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class UserProfileController {
  constructor(private readonly userProfileService: UserProfileService) {}

  @Get()
  @ApiOperation({ summary: 'Récupérer le profil utilisateur' })
  @ApiResponse({ status: 200, description: 'Profil récupéré avec succès' })
  @ApiResponse({ status: 401, description: 'Non autorisé' })
  async getProfile(@Request() req) {
    return this.userProfileService.getProfile(req.user.userId);
  }

  @Put()
  @ApiOperation({ summary: 'Mettre à jour le profil utilisateur' })
  @ApiResponse({ status: 200, description: 'Profil mis à jour avec succès' })
  @ApiResponse({ status: 401, description: 'Non autorisé' })
  async updateProfile(@Request() req, @Body() updateProfileDto: UpdateProfileDto) {
    return this.userProfileService.updateProfile(req.user.userId, updateProfileDto);
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Supprimer le compte utilisateur' })
  @ApiResponse({ status: 204, description: 'Compte supprimé avec succès' })
  @ApiResponse({ status: 401, description: 'Non autorisé' })
  @ApiResponse({ status: 400, description: 'Requête invalide' })
  async deleteAccount(@Request() req) {
    if (!req.user || !req.user.userId) {
      throw new Error('ID utilisateur manquant dans la requête. Veuillez vous reconnecter.');
    }
    console.log('Suppression du compte utilisateur avec ID:', req.user.userId);
    await this.userProfileService.deleteAccount(req.user.userId);
  }
}
