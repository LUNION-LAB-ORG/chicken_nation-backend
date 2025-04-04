import { Controller, Get, Post, Put, Delete, Param, Body, UseGuards, HttpCode } from '@nestjs/common';
import { CategoryService } from '../services/category.service';
import { Category } from '../entities/category.entity';
import { CreateCategoryDto, UpdateCategoryDto } from '../dto/category.dto';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiParam, ApiBody } from '@nestjs/swagger';

@ApiTags('menu')
@Controller('categories')
export class CategoryController {
  constructor(private readonly categoryService: CategoryService) {}

  @Get()
  @ApiOperation({ summary: 'Récupérer toutes les catégories', description: 'Retourne toutes les catégories actives triées par nom' })
  @ApiResponse({ status: 200, description: 'Liste des catégories récupérée avec succès', type: [Category] })
  async getAllCategories(): Promise<Category[]> {
    return this.categoryService.getAllCategories();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Récupérer une catégorie par ID', description: 'Retourne une catégorie spécifique en fonction de son ID' })
  @ApiParam({ name: 'id', description: 'ID de la catégorie', type: 'string' })
  @ApiResponse({ status: 200, description: 'Catégorie récupérée avec succès', type: Category })
  @ApiResponse({ status: 404, description: 'Catégorie non trouvée' })
  async getCategoryById(@Param('id') id: string): Promise<Category> {
    return this.categoryService.getCategoryById(id);
  }

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'manager')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Créer une nouvelle catégorie', description: 'Crée une nouvelle catégorie dans le système (réservé aux administrateurs et managers)' })
  @ApiBody({ type: CreateCategoryDto })
  @ApiResponse({ status: 201, description: 'Catégorie créée avec succès', type: Category })
  @ApiResponse({ status: 401, description: 'Non autorisé' })
  @ApiResponse({ status: 403, description: 'Accès interdit' })
  async createCategory(@Body() createCategoryDto: CreateCategoryDto): Promise<Category> {
    return this.categoryService.createCategory(createCategoryDto);
  }

  @Put(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'manager')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Mettre à jour une catégorie', description: 'Met à jour une catégorie existante (réservé aux administrateurs et managers)' })
  @ApiParam({ name: 'id', description: 'ID de la catégorie', type: 'string' })
  @ApiBody({ type: UpdateCategoryDto })
  @ApiResponse({ status: 200, description: 'Catégorie mise à jour avec succès', type: Category })
  @ApiResponse({ status: 401, description: 'Non autorisé' })
  @ApiResponse({ status: 403, description: 'Accès interdit' })
  @ApiResponse({ status: 404, description: 'Catégorie non trouvée' })
  async updateCategory(
    @Param('id') id: string,
    @Body() updateCategoryDto: UpdateCategoryDto,
  ): Promise<Category> {
    return this.categoryService.updateCategory(id, updateCategoryDto);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'manager')
  @HttpCode(204)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Supprimer une catégorie', description: 'Supprime une catégorie existante (soft delete, réservé aux administrateurs et managers)' })
  @ApiParam({ name: 'id', description: 'ID de la catégorie', type: 'string' })
  @ApiResponse({ status: 204, description: 'Catégorie supprimée avec succès' })
  @ApiResponse({ status: 401, description: 'Non autorisé' })
  @ApiResponse({ status: 403, description: 'Accès interdit' })
  @ApiResponse({ status: 404, description: 'Catégorie non trouvée' })
  async deleteCategory(@Param('id') id: string): Promise<void> {
    await this.categoryService.deleteCategory(id);
  }
}