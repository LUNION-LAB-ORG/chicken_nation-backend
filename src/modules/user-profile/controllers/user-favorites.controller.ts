import { Controller, Get, Post, Delete, UseGuards, Request, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { UserFavoritesService } from '../services/user-favorites.service';
import { AddFavoriteDto } from '../dto/add-favorite.dto';

@ApiTags('user-favorites')
@Controller('user-profile/favorites')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class UserFavoritesController {
  constructor(private readonly userFavoritesService: UserFavoritesService) {}

  @Get()
  @ApiOperation({ summary: 'Récupérer tous les favoris de l\'utilisateur' })
  @ApiResponse({ status: 200, description: 'Favoris récupérés avec succès' })
  @ApiResponse({ status: 401, description: 'Non autorisé' })
  async getUserFavorites(@Request() req) {
    return this.userFavoritesService.getUserFavorites(req.user.userId);
  }

  @Post()
  @ApiOperation({ summary: 'Ajouter un favori' })
  @ApiResponse({ status: 201, description: 'Favori ajouté avec succès' })
  @ApiResponse({ status: 401, description: 'Non autorisé' })
  async addFavorite(@Request() req, @Body() addFavoriteDto: AddFavoriteDto) {
    return this.userFavoritesService.addFavorite(req.user.userId, addFavoriteDto);
  }

  @Delete()
  @ApiOperation({ summary: 'Supprimer un favori' })
  @ApiResponse({ status: 200, description: 'Favori supprimé avec succès' })
  @ApiResponse({ status: 401, description: 'Non autorisé' })
  @ApiResponse({ status: 404, description: 'Favori non trouvé' })
  async removeFavorite(@Request() req, @Body() favoriteDto: AddFavoriteDto) {
    return this.userFavoritesService.removeFavorite(req.user.userId, favoriteDto);
  }
}
