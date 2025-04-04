import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Category } from '../entities/category.entity';
import { CreateCategoryDto, UpdateCategoryDto } from '../dto/category.dto';

@Injectable()
export class CategoryService {
  constructor(
    @InjectRepository(Category)
    private categoryRepository: Repository<Category>,
  ) {}

  async getAllCategories(): Promise<Category[]> {
    return await this.categoryRepository.find({
      where: { isActive: true },
      order: { name: 'ASC' },
    });
  }

  async getCategoryById(id: string): Promise<Category> {
    try {
      // Essayer d'abord avec findOne
      let category = await this.categoryRepository.findOne({ 
        where: { id: id }
      });
      
      // Si aucun résultat, essayer avec une requête SQL brute
      if (!category) {
        console.log(`Catégorie non trouvée avec findOne, essai avec requête SQL pour ID: ${id}`);
        const categories = await this.categoryRepository.query(
          'SELECT * FROM categories WHERE id::text = $1 OR id = $1',
          [id.toString()]
        );
        
        if (categories && categories.length > 0) {
          category = categories[0];
          console.log(`Catégorie trouvée avec requête SQL: ${category.id}`);
        }
      }
      
      if (!category) {
        throw new NotFoundException(`Category with ID ${id} not found`);
      }
      
      return category;
    } catch (error) {
      console.error(`Erreur lors de la recherche de la catégorie avec ID ${id}:`, error);
      throw new NotFoundException(`Category with ID ${id} not found`);
    }
  }

  async createCategory(createCategoryDto: CreateCategoryDto): Promise<Category> {
    const newCategory = this.categoryRepository.create(createCategoryDto);
    return await this.categoryRepository.save(newCategory);
  }

  async updateCategory(id: string, updateCategoryDto: UpdateCategoryDto): Promise<Category> {
    try {
      // Essayer de trouver la catégorie
      const category = await this.getCategoryById(id);
      
      // Mettre à jour les propriétés
      const updatedCategory = { ...category, ...updateCategoryDto };
      
      // Sauvegarder les modifications
      console.log(`Mise à jour de la catégorie ${id} avec:`, updateCategoryDto);
      return await this.categoryRepository.save(updatedCategory);
    } catch (error) {
      console.error(`Erreur lors de la mise à jour de la catégorie ${id}:`, error);
      throw error;
    }
  }

  async deleteCategory(id: string): Promise<void> {
    try {
      // Trouver la catégorie
      const category = await this.getCategoryById(id);
      
      // Soft delete (marquer comme inactif)
      console.log(`Suppression (soft delete) de la catégorie ${id}`);
      await this.categoryRepository.save({ ...category, isActive: false });
    } catch (error) {
      console.error(`Erreur lors de la suppression de la catégorie ${id}:`, error);
      throw error;
    }
  }
}