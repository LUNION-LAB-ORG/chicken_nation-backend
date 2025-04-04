import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RestaurantSchedule } from '../entities/restaurant-schedule.entity';
import { CreateRestaurantScheduleDto } from '../dto/create-restaurant-schedule.dto';
import { RestaurantsService } from './restaurants.service';

@Injectable()
export class RestaurantSchedulesService {
  private readonly logger = new Logger(RestaurantSchedulesService.name);

  constructor(
    @InjectRepository(RestaurantSchedule)
    private scheduleRepository: Repository<RestaurantSchedule>,
    private restaurantsService: RestaurantsService,
  ) {}

  /**
   * Cru00e9e un nouvel horaire pour un restaurant
   * @param restaurantId ID du restaurant
   * @param createScheduleDto Donnu00e9es de l'horaire u00e0 cru00e9er
   * @returns L'horaire cru00e9u00e9
   */
  async create(restaurantId: string, createScheduleDto: CreateRestaurantScheduleDto): Promise<RestaurantSchedule> {
    // Vu00e9rifier que le restaurant existe
    await this.restaurantsService.findOne(restaurantId);
    
    // Cru00e9er l'horaire
    const schedule = this.scheduleRepository.create({
      restaurantId,
      ...createScheduleDto,
    });
    
    return this.scheduleRepository.save(schedule);
  }

  /**
   * Ru00e9cupu00e8re tous les horaires d'un restaurant
   * @param restaurantId ID du restaurant
   * @returns Liste des horaires
   */
  async findAllForRestaurant(restaurantId: string): Promise<RestaurantSchedule[]> {
    // Vu00e9rifier que le restaurant existe
    await this.restaurantsService.findOne(restaurantId);
    
    return this.scheduleRepository.find({
      where: { restaurantId },
      order: {
        day: 'ASC',
      },
    });
  }

  /**
   * Ru00e9cupu00e8re un horaire spu00e9cifique d'un restaurant
   * @param restaurantId ID du restaurant
   * @param day Jour de la semaine
   * @returns L'horaire trouvu00e9
   */
  async findOne(restaurantId: string, day: string): Promise<RestaurantSchedule> {
    const schedule = await this.scheduleRepository.findOne({
      where: { restaurantId, day },
    });
    
    if (!schedule) {
      throw new NotFoundException(`Horaire pour le jour ${day} non trouvu00e9 pour le restaurant ${restaurantId}`);
    }
    
    return schedule;
  }

  /**
   * Met u00e0 jour un horaire de restaurant
   * @param restaurantId ID du restaurant
   * @param day Jour de la semaine
   * @param updateData Donnu00e9es u00e0 mettre u00e0 jour
   * @returns L'horaire mis u00e0 jour
   */
  async update(
    restaurantId: string,
    day: string,
    updateData: Partial<CreateRestaurantScheduleDto>,
  ): Promise<RestaurantSchedule> {
    const schedule = await this.findOne(restaurantId, day);
    
    // Mettre u00e0 jour les propriu00e9tu00e9s
    Object.assign(schedule, updateData);
    
    return this.scheduleRepository.save(schedule);
  }

  /**
   * Supprime un horaire de restaurant
   * @param restaurantId ID du restaurant
   * @param day Jour de la semaine
   * @returns Message de confirmation
   */
  async remove(restaurantId: string, day: string): Promise<{ message: string }> {
    const schedule = await this.findOne(restaurantId, day);
    await this.scheduleRepository.remove(schedule);
    
    return { message: `Horaire pour le jour ${day} supprimu00e9 avec succu00e8s` };
  }

  /**
   * Cru00e9e ou met u00e0 jour plusieurs horaires pour un restaurant
   * @param restaurantId ID du restaurant
   * @param schedulesData Donnu00e9es des horaires
   * @returns Les horaires cru00e9u00e9s ou mis u00e0 jour
   */
  async createOrUpdateBulk(
    restaurantId: string,
    schedulesData: CreateRestaurantScheduleDto[],
  ): Promise<RestaurantSchedule[]> {
    // Vu00e9rifier que le restaurant existe
    await this.restaurantsService.findOne(restaurantId);
    
    const results: RestaurantSchedule[] = [];
    
    for (const scheduleData of schedulesData) {
      try {
        // Vu00e9rifier si l'horaire existe du00e9ju00e0
        const existingSchedule = await this.scheduleRepository.findOne({
          where: { restaurantId, day: scheduleData.day },
        });
        
        if (existingSchedule) {
          // Mettre u00e0 jour l'horaire existant
          Object.assign(existingSchedule, scheduleData);
          results.push(await this.scheduleRepository.save(existingSchedule));
        } else {
          // Cru00e9er un nouvel horaire
          const newSchedule = this.scheduleRepository.create({
            restaurantId,
            ...scheduleData,
          });
          results.push(await this.scheduleRepository.save(newSchedule));
        }
      } catch (error) {
        this.logger.error(`Erreur lors de la cru00e9ation/mise u00e0 jour de l'horaire pour ${scheduleData.day}`, error.stack);
        throw error;
      }
    }
    
    return results;
  }
}
