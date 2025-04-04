import { Controller, Get, Post, Put, Patch, Delete, Param, Body, Query, UseGuards, HttpCode, DefaultValuePipe } from '@nestjs/common';
import { MenuItemService } from '../services/menuItem.service';
import { MenuItem } from '../entities/menuItem.entity';
import { CreateMenuItemDto, UpdateMenuItemDto, PromotionDto } from '../dto/menuItem.dto';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiParam, ApiQuery, ApiBody } from '@nestjs/swagger';

@ApiTags('menu')
@Controller('menu-items')
export class MenuItemController {
  constructor(private readonly menuItemService: MenuItemService) {}

  @Get()
  @ApiOperation({ summary: 'Récupérer tous les articles du menu', description: 'Retourne tous les articles du menu disponibles, avec possibilité de filtrer par catégorie' })
  @ApiQuery({ name: 'categoryId', description: 'ID de la catégorie pour filtrer les résultats', required: false, type: 'string' })
  @ApiResponse({ status: 200, description: 'Liste des articles du menu récupérée avec succès', type: [MenuItem] })
  async getAllMenuItems(
    @Query('categoryId') categoryId?: string,
  ): Promise<MenuItem[]> {
    return categoryId ? 
      this.menuItemService.getAllMenuItems(categoryId) : 
      this.menuItemService.getAllMenuItems();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Récupérer un article du menu par ID', description: 'Retourne un article du menu spécifique en fonction de son ID' })
  @ApiParam({ name: 'id', description: 'ID de l\'article du menu', type: 'string' })
  @ApiResponse({ status: 200, description: 'Article du menu récupéré avec succès', type: MenuItem })
  @ApiResponse({ status: 404, description: 'Article du menu non trouvé' })
  async getMenuItemById(@Param('id') id: string): Promise<MenuItem> {
    return this.menuItemService.getMenuItemById(id);
  }

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'manager')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Créer un nouvel article du menu', description: 'Crée un nouvel article du menu dans le système (réservé aux administrateurs et managers)' })
  @ApiBody({ type: CreateMenuItemDto })
  @ApiResponse({ status: 201, description: 'Article du menu créé avec succès', type: MenuItem })
  @ApiResponse({ status: 401, description: 'Non autorisé' })
  @ApiResponse({ status: 403, description: 'Accès interdit' })
  @ApiResponse({ status: 404, description: 'Catégorie non trouvée' })
  async createMenuItem(@Body() createMenuItemDto: CreateMenuItemDto): Promise<MenuItem> {
    return this.menuItemService.createMenuItem(createMenuItemDto);
  }

  @Put(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'manager')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Mettre à jour un article du menu', description: 'Met à jour un article du menu existant (réservé aux administrateurs et managers)' })
  @ApiParam({ name: 'id', description: 'ID de l\'article du menu', type: 'string' })
  @ApiBody({ type: UpdateMenuItemDto })
  @ApiResponse({ status: 200, description: 'Article du menu mis à jour avec succès', type: MenuItem })
  @ApiResponse({ status: 401, description: 'Non autorisé' })
  @ApiResponse({ status: 403, description: 'Accès interdit' })
  @ApiResponse({ status: 404, description: 'Article du menu ou catégorie non trouvé' })
  async updateMenuItem(
    @Param('id') id: string,
    @Body() updateMenuItemDto: UpdateMenuItemDto,
  ): Promise<MenuItem> {
    return this.menuItemService.updateMenuItem(id, updateMenuItemDto);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'manager')
  @HttpCode(204)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Supprimer un article du menu', description: 'Supprime un article du menu existant (soft delete, réservé aux administrateurs et managers)' })
  @ApiParam({ name: 'id', description: 'ID de l\'article du menu', type: 'string' })
  @ApiResponse({ status: 204, description: 'Article du menu supprimé avec succès' })
  @ApiResponse({ status: 401, description: 'Non autorisé' })
  @ApiResponse({ status: 403, description: 'Accès interdit' })
  @ApiResponse({ status: 404, description: 'Article du menu non trouvé' })
  async deleteMenuItem(@Param('id') id: string): Promise<void> {
    await this.menuItemService.deleteMenuItem(id);
  }

  @Patch(':id/promotion')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'manager')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Appliquer une promotion à un article du menu', description: 'Applique une promotion à un article du menu existant (réservé aux administrateurs et managers)' })
  @ApiParam({ name: 'id', description: 'ID de l\'article du menu', type: 'string' })
  @ApiBody({ type: PromotionDto })
  @ApiResponse({ status: 200, description: 'Promotion appliquée avec succès', type: MenuItem })
  @ApiResponse({ status: 401, description: 'Non autorisé' })
  @ApiResponse({ status: 403, description: 'Accès interdit' })
  @ApiResponse({ status: 404, description: 'Article du menu non trouvé' })
  async setPromotion(
    @Param('id') id: string,
    @Body() promotionDto: PromotionDto,
  ): Promise<MenuItem> {
    return this.menuItemService.setPromotion(id, promotionDto);
  }
}