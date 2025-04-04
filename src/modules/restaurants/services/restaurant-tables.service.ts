import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RestaurantTable } from '../entities/restaurant-table.entity';
import { CreateRestaurantTableDto } from '../dto/create-restaurant-table.dto';
import { RestaurantsService } from './restaurants.service';

@Injectable()
export class RestaurantTablesService {
  private readonly logger = new Logger(RestaurantTablesService.name);

  constructor(
    @InjectRepository(RestaurantTable)
    private tableRepository: Repository<RestaurantTable>,
    private restaurantsService: RestaurantsService,
  ) {}

  /**
   * Crée une nouvelle configuration de table pour un restaurant
   * @param restaurantId ID du restaurant
   * @param createTableDto Données de la table à créer
   * @returns La configuration de table créée
   */
  async create(restaurantId: string, createTableDto: CreateRestaurantTableDto): Promise<RestaurantTable> {
    // Vérifier que le restaurant existe
    await this.restaurantsService.findOne(restaurantId);
    
    // Créer la configuration de table
    const table = this.tableRepository.create({
      restaurantId,
      ...createTableDto,
    });
    
    return this.tableRepository.save(table);
  }

  /**
   * Récupère toutes les configurations de tables d'un restaurant
   * @param restaurantId ID du restaurant
   * @returns Liste des configurations de tables
   */
  async findAllForRestaurant(restaurantId: string): Promise<RestaurantTable[]> {
    // Vérifier que le restaurant existe
    await this.restaurantsService.findOne(restaurantId);
    
    return this.tableRepository.find({
      where: { restaurantId },
      order: {
        capacity: 'ASC',
      },
    });
  }

  /**
   * Récupère une configuration de table spécifique d'un restaurant
   * @param restaurantId ID du restaurant
   * @param capacity Capacité de la table
   * @param type Type de la table
   * @returns La configuration de table trouvée
   */
  async findOne(restaurantId: string, capacity: number, type: string): Promise<RestaurantTable> {
    const table = await this.tableRepository.findOne({
      where: { restaurantId, capacity, type },
    });
    
    if (!table) {
      throw new NotFoundException(`Table de capacité ${capacity} et de type ${type} non trouvée pour le restaurant ${restaurantId}`);
    }
    
    return table;
  }

  /**
   * Met à jour une configuration de table de restaurant
   * @param restaurantId ID du restaurant
   * @param capacity Capacité de la table
   * @param type Type de la table
   * @param updateData Données à mettre à jour
   * @returns La configuration de table mise à jour
   */
  async update(
    restaurantId: string,
    capacity: number,
    type: string,
    updateData: { quantity: number },
  ): Promise<RestaurantTable> {
    const table = await this.findOne(restaurantId, capacity, type);
    
    // Mettre à jour la quantité
    table.quantity = updateData.quantity;
    
    return this.tableRepository.save(table);
  }

  /**
   * Supprime une configuration de table de restaurant
   * @param restaurantId ID du restaurant
   * @param capacity Capacité de la table
   * @param type Type de la table
   * @returns Message de confirmation
   */
  async remove(restaurantId: string, capacity: number, type: string): Promise<{ message: string }> {
    const table = await this.findOne(restaurantId, capacity, type);
    await this.tableRepository.remove(table);
    
    return { message: `Configuration de table supprimée avec succès` };
  }

  /**
   * Crée ou met à jour plusieurs configurations de tables pour un restaurant
   * @param restaurantId ID du restaurant
   * @param tablesData Données des configurations de tables
   * @returns Les configurations de tables créées ou mises à jour
   */
  async createOrUpdateBulk(
    restaurantId: string,
    tablesData: CreateRestaurantTableDto[],
  ): Promise<RestaurantTable[]> {
    // Vérifier que le restaurant existe
    await this.restaurantsService.findOne(restaurantId);
    
    const results: RestaurantTable[] = [];
    
    for (const tableData of tablesData) {
      try {
        // Vérifier si la configuration de table existe déjà
        const existingTable = await this.tableRepository.findOne({
          where: { 
            restaurantId, 
            capacity: tableData.capacity, 
            type: tableData.type 
          },
        });
        
        if (existingTable) {
          // Mettre à jour la configuration de table existante
          existingTable.quantity = tableData.quantity;
          results.push(await this.tableRepository.save(existingTable));
        } else {
          // Créer une nouvelle configuration de table
          const newTable = this.tableRepository.create({
            restaurantId,
            ...tableData,
          });
          results.push(await this.tableRepository.save(newTable));
        }
      } catch (error) {
        this.logger.error(`Erreur lors de la création/mise à jour de la configuration de table`, error.stack);
        throw error;
      }
    }
    
    return results;
  }
}
