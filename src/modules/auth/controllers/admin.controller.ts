import { Controller, Post, Delete, Get, Body, UseGuards, Param, HttpCode, HttpStatus, Query, Request, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiParam, ApiQuery } from '@nestjs/swagger';
import { AuthService } from '../services/auth.service';
import { AdminService } from '../services/admin.service';
import { CreateAdminDto } from '../dto/create-admin.dto';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { RolesGuard } from '../guards/roles.guard';
import { Roles } from '../decorators/roles.decorator';

@ApiTags('admin')
@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@ApiBearerAuth()
export class AdminController {
  constructor(
    private readonly authService: AuthService,
    private readonly adminService: AdminService,
  ) {}

  @Post('users')
  @ApiOperation({ summary: 'Créer un nouvel utilisateur admin ou manager', description: 'Réservé aux administrateurs' })
  @ApiResponse({ status: 201, description: 'Utilisateur créé avec succès' })
  @ApiResponse({ status: 400, description: 'Données invalides' })
  @ApiResponse({ status: 401, description: 'Non autorisé' })
  @ApiResponse({ status: 403, description: 'Accès interdit' })
  async createAdminUser(@Body() createAdminDto: CreateAdminDto) {
    return this.authService.createAdminUser(createAdminDto);
  }

  @Delete('users/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Supprimer un compte utilisateur', description: 'Réservé aux administrateurs' })
  @ApiParam({ name: 'id', description: 'ID de l\'utilisateur à supprimer' })
  @ApiResponse({ status: 204, description: 'Utilisateur supprimé avec succès' })
  @ApiResponse({ status: 400, description: 'Tentative de suppression d\'un compte administrateur' })
  @ApiResponse({ status: 401, description: 'Non autorisé' })
  @ApiResponse({ status: 403, description: 'Accès interdit' })
  @ApiResponse({ status: 404, description: 'Utilisateur non trouvé' })
  async deleteUser(@Param('id') id: string, @Request() req) {
    // Vérifier que l'administrateur ne tente pas de supprimer son propre compte
    if (id === req.user.userId) {
      throw new BadRequestException('Vous ne pouvez pas supprimer votre propre compte administrateur');
    }
    
    await this.adminService.deleteUser(id);
  }

  @Delete('users/:id/force')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Forcer la suppression d\'un compte administrateur ou manager', description: 'Réservé aux administrateurs' })
  @ApiParam({ name: 'id', description: 'ID de l\'administrateur ou manager à supprimer' })
  @ApiResponse({ status: 204, description: 'Utilisateur supprimé avec succès' })
  @ApiResponse({ status: 400, description: 'Tentative de suppression d\'un compte administrateur ou manager' })
  @ApiResponse({ status: 401, description: 'Non autorisé' })
  @ApiResponse({ status: 403, description: 'Accès interdit' })
  @ApiResponse({ status: 404, description: 'Utilisateur non trouvé' })
  @Roles('admin') // Restriction aux administrateurs
  async forceDeleteUser(@Param('id') id: string, @Body() body: { confirmation: string }) {
    // Vérifier que la confirmation est correcte
    if (body.confirmation !== 'SUPPRIMER-ADMIN') {
      throw new BadRequestException('Confirmation invalide. Veuillez saisir "SUPPRIMER-ADMIN" pour confirmer.');
    }
    
    // Procéder à la suppression forcée
    await this.adminService.deleteUser(id, true); // Le deuxième paramètre indique une suppression forcée
  }

  @Get('users')
  @ApiOperation({ summary: 'Récupérer tous les utilisateurs', description: 'Réservé aux administrateurs' })
  @ApiQuery({ name: 'page', required: false, description: 'Numéro de page', type: Number })
  @ApiQuery({ name: 'limit', required: false, description: 'Nombre d\'utilisateurs par page', type: Number })
  @ApiQuery({ name: 'search', required: false, description: 'Terme de recherche (nom, email, etc.)', type: String })
  @ApiResponse({ status: 200, description: 'Liste des utilisateurs récupérée avec succès' })
  @ApiResponse({ status: 401, description: 'Non autorisé' })
  @ApiResponse({ status: 403, description: 'Accès interdit' })
  async getAllUsers(
    @Query('page') page: number = 1,
    @Query('limit') limit: number = 10,
    @Query('search') search?: string,
  ) {
    return this.adminService.getAllUsers(page, limit, search);
  }
}
