import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { UserFavorite } from '../entities/user-favorite.entity';
import { AddFavoriteDto } from '../dto/add-favorite.dto';
import * as crypto from 'crypto';

@Injectable()
export class UserFavoritesService {
  private readonly logger = new Logger(UserFavoritesService.name);

  constructor(
    @InjectRepository(UserFavorite)
    private favoritesRepository: Repository<UserFavorite>,
  ) {}

  /**
   * Récupère tous les favoris d'un utilisateur
   * @param userId ID de l'utilisateur
   * @returns Liste des favoris de l'utilisateur
   */
  async getUserFavorites(userId: string): Promise<UserFavorite[]> {
    return this.favoritesRepository.find({
      where: { userId },
    });
  }

  /**
   * Ajoute un restaurant ou un produit aux favoris
   * @param userId ID de l'utilisateur
   * @param addFavoriteDto Données du favori à ajouter
   * @returns Le favori ajouté
   */
  async addFavorite(userId: string, addFavoriteDto: AddFavoriteDto): Promise<UserFavorite> {
    // Vérifier qu'au moins un ID est fourni
    if (!addFavoriteDto.restaurantId && !addFavoriteDto.productId) {
      throw new Error('Vous devez spécifier un restaurant ou un produit');
    }

    // Vérifier si ce favori existe déjà
    const existingFavorite = await this.favoritesRepository.findOne({
      where: {
        userId,
        restaurantId: addFavoriteDto.restaurantId || null,
        productId: addFavoriteDto.productId || null,
      },
    });

    if (existingFavorite) {
      return existingFavorite; // Déjà dans les favoris
    }

    // Créer un nouveau favori avec un UUID généré manuellement
    const newFavorite = this.favoritesRepository.create({
      id: crypto.randomUUID(), // Générer manuellement un UUID
      userId,
      restaurantId: addFavoriteDto.restaurantId || null,
      productId: addFavoriteDto.productId || null,
    });

    return this.favoritesRepository.save(newFavorite);
  }

  /**
   * Supprime un favori
   * @param userId ID de l'utilisateur
   * @param favoriteDto Données du favori à supprimer
   * @returns Message de confirmation
   */
  async removeFavorite(userId: string, favoriteDto: AddFavoriteDto): Promise<{ message: string }> {
    // Vérifier qu'au moins un ID est fourni
    if (!favoriteDto.restaurantId && !favoriteDto.productId) {
      throw new Error('Vous devez spécifier un restaurant ou un produit');
    }

    // Trouver le favori à supprimer
    const favorite = await this.favoritesRepository.findOne({
      where: {
        userId,
        restaurantId: favoriteDto.restaurantId || null,
        productId: favoriteDto.productId || null,
      },
    });

    if (!favorite) {
      throw new NotFoundException('Favori non trouvé');
    }

    await this.favoritesRepository.remove(favorite);
    return { message: 'Favori supprimé avec succès' };
  }
}
