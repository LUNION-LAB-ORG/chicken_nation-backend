import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { RestaurantReservationSlot } from '../entities/restaurant-reservation-slot.entity';
import { CreateReservationSlotDto } from '../dto/create-reservation-slot.dto';
import { RestaurantsService } from './restaurants.service';

@Injectable()
export class RestaurantReservationSlotsService {
  private readonly logger = new Logger(RestaurantReservationSlotsService.name);

  constructor(
    @InjectRepository(RestaurantReservationSlot)
    private slotRepository: Repository<RestaurantReservationSlot>,
    private restaurantsService: RestaurantsService,
  ) {}

  /**
   * Crée un nouveau créneau de réservation pour un restaurant
   * @param restaurantId ID du restaurant
   * @param createSlotDto Données du créneau à créer
   * @returns Le créneau créé
   */
  async create(restaurantId: string, createSlotDto: CreateReservationSlotDto): Promise<RestaurantReservationSlot> {
    // Vérifier que le restaurant existe
    await this.restaurantsService.findOne(restaurantId);
    
    // Créer le créneau
    const slot = this.slotRepository.create({
      restaurantId,
      timeSlot: createSlotDto.time_slot,
    });
    
    return this.slotRepository.save(slot);
  }

  /**
   * Récupère tous les créneaux de réservation d'un restaurant
   * @param restaurantId ID du restaurant
   * @returns Liste des créneaux
   */
  async findAllForRestaurant(restaurantId: string): Promise<RestaurantReservationSlot[]> {
    // Vérifier que le restaurant existe
    await this.restaurantsService.findOne(restaurantId);
    
    return this.slotRepository.find({
      where: { restaurantId },
      order: {
        timeSlot: 'ASC',
      },
    });
  }

  /**
   * Récupère un créneau spécifique d'un restaurant
   * @param restaurantId ID du restaurant
   * @param timeSlot Créneau horaire
   * @returns Le créneau trouvé
   */
  async findOne(restaurantId: string, timeSlot: string): Promise<RestaurantReservationSlot> {
    const slot = await this.slotRepository.findOne({
      where: { restaurantId, timeSlot },
    });
    
    if (!slot) {
      throw new NotFoundException(`Créneau ${timeSlot} non trouvé pour le restaurant ${restaurantId}`);
    }
    
    return slot;
  }

  /**
   * Supprime un créneau de réservation
   * @param restaurantId ID du restaurant
   * @param timeSlot Créneau horaire
   * @returns Message de confirmation
   */
  async remove(restaurantId: string, timeSlot: string): Promise<{ message: string }> {
    const slot = await this.findOne(restaurantId, timeSlot);
    await this.slotRepository.remove(slot);
    
    return { message: `Créneau ${timeSlot} supprimé avec succès` };
  }

  /**
   * Crée ou met à jour plusieurs créneaux pour un restaurant
   * @param restaurantId ID du restaurant
   * @param slotsData Données des créneaux
   * @returns Les créneaux créés
   */
  async createOrUpdateBulk(
    restaurantId: string,
    slotsData: CreateReservationSlotDto[],
  ): Promise<RestaurantReservationSlot[]> {
    // Vérifier que le restaurant existe
    await this.restaurantsService.findOne(restaurantId);
    
    // Supprimer tous les créneaux existants pour ce restaurant
    await this.slotRepository.delete({ restaurantId });
    
    // Créer les nouveaux créneaux
    const slots = slotsData.map(slotData => this.slotRepository.create({
      restaurantId,
      timeSlot: slotData.time_slot,
    }));
    
    return this.slotRepository.save(slots);
  }
}
