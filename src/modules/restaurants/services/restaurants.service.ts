import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Restaurant } from '../entities/restaurant.entity';
import { CreateRestaurantDto } from '../dto/create-restaurant.dto';
import { UpdateRestaurantDto } from '../dto/update-restaurant.dto';

@Injectable()
export class RestaurantsService {
  private readonly logger = new Logger(RestaurantsService.name);

  constructor(
    @InjectRepository(Restaurant)
    private restaurantRepository: Repository<Restaurant>,
  ) {}

  /**
   * Crée un nouveau restaurant
   * @param createRestaurantDto Données du restaurant à créer
   * @returns Le restaurant créé
   */
  async create(createRestaurantDto: CreateRestaurantDto): Promise<Restaurant> {
    const restaurant = this.restaurantRepository.create(createRestaurantDto);
    return this.restaurantRepository.save(restaurant);
  }

  /**
   * Récupère tous les restaurants avec filtres optionnels
   * @param options Options de filtrage
   * @returns Liste des restaurants
   */
  async findAll(options?: { isOpen?: boolean; location?: string }): Promise<Restaurant[]> {
    const queryBuilder = this.restaurantRepository.createQueryBuilder('restaurant');
    
    if (options?.isOpen !== undefined) {
      queryBuilder.andWhere('restaurant.is_open = :isOpen', { isOpen: options.isOpen });
    }
    
    if (options?.location) {
      queryBuilder.andWhere('restaurant.location ILIKE :location', { location: `%${options.location}%` });
    }
    
    return queryBuilder.getMany();
  }

  /**
   * Récupère un restaurant par son ID
   * @param id ID du restaurant
   * @returns Le restaurant trouvé
   */
  async findOne(id: string): Promise<Restaurant> {
    const restaurant = await this.restaurantRepository.findOne({
      where: { id },
      relations: ['schedules', 'tables', 'reservation_slots'],
    });
    
    if (!restaurant) {
      throw new NotFoundException(`Restaurant avec l'ID ${id} non trouvé`);
    }
    
    return restaurant;
  }

  /**
   * Met à jour un restaurant
   * @param id ID du restaurant
   * @param updateRestaurantDto Données à mettre à jour
   * @returns Le restaurant mis à jour
   */
  async update(id: string, updateRestaurantDto: UpdateRestaurantDto): Promise<Restaurant> {
    const restaurant = await this.findOne(id);
    
    // Mettre à jour les propriétés
    Object.assign(restaurant, updateRestaurantDto);
    
    return this.restaurantRepository.save(restaurant);
  }

  /**
   * Supprime un restaurant
   * @param id ID du restaurant
   * @returns Message de confirmation
   */
  async remove(id: string): Promise<{ message: string }> {
    const restaurant = await this.findOne(id);
    await this.restaurantRepository.remove(restaurant);
    
    return { message: `Restaurant avec l'ID ${id} supprimé avec succès` };
  }

  /**
   * Recherche des restaurants par nom
   * @param name Nom à rechercher
   * @returns Liste des restaurants correspondants
   */
  async searchByName(name: string): Promise<Restaurant[]> {
    return this.restaurantRepository
      .createQueryBuilder('restaurant')
      .where('restaurant.name ILIKE :name', { name: `%${name}%` })
      .getMany();
  }

  /**
   * Récupère les restaurants les mieux notés
   * @param limit Nombre de restaurants à récupérer
   * @returns Liste des restaurants les mieux notés
   */
  async getTopRated(limit: number = 10): Promise<Restaurant[]> {
    // Cette méthode nécessiterait une logique supplémentaire pour calculer la note moyenne
    // basée sur les avis des produits du restaurant
    return this.restaurantRepository
      .createQueryBuilder('restaurant')
      .leftJoin('restaurant.menu_items', 'menuItem')
      .select('restaurant')
      .addSelect('AVG(menuItem.rating)', 'avgRating')
      .groupBy('restaurant.id')
      .orderBy('avgRating', 'DESC')
      .limit(limit)
      .getMany();
  }
}
