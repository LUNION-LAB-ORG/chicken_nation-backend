import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between } from 'typeorm';
import { TableReservation } from '../entities/table-reservation.entity';
import { CreateTableReservationDto } from '../dto/create-table-reservation.dto';
import { RestaurantsService } from './restaurants.service';
import { RestaurantTablesService } from './restaurant-tables.service';
import { RestaurantReservationSlotsService } from './restaurant-reservation-slots.service';

@Injectable()
export class TableReservationsService {
  private readonly logger = new Logger(TableReservationsService.name);

  constructor(
    @InjectRepository(TableReservation)
    private reservationRepository: Repository<TableReservation>,
    private restaurantsService: RestaurantsService,
    private tablesService: RestaurantTablesService,
    private slotsService: RestaurantReservationSlotsService,
  ) {}

  /**
   * Crée une nouvelle réservation de table
   * @param userId ID de l'utilisateur qui fait la réservation
   * @param createReservationDto Données de la réservation
   * @returns La réservation créée
   */
  async create(userId: string, createReservationDto: CreateTableReservationDto): Promise<TableReservation> {
    const { restaurant_id, reservation_date, reservation_time, party_size } = createReservationDto;
    
    // Vérifier que le restaurant existe
    const restaurant = await this.restaurantsService.findOne(restaurant_id);
    
    // Vérifier que la taille du groupe est valide
    if (party_size < restaurant.min_reservation_size || party_size > restaurant.max_reservation_size) {
      throw new BadRequestException(
        `La taille du groupe doit être entre ${restaurant.min_reservation_size} et ${restaurant.max_reservation_size} personnes`
      );
    }
    
    // Vérifier que le créneau horaire est disponible pour ce restaurant
    try {
      await this.slotsService.findOne(restaurant_id, reservation_time);
    } catch (error) {
      throw new BadRequestException(`Le créneau horaire ${reservation_time} n'est pas disponible pour ce restaurant`);
    }
    
    // Vérifier la disponibilité des tables pour cette date et ce créneau
    const existingReservations = await this.reservationRepository.find({
      where: {
        restaurantId: restaurant_id,
        reservationDate: new Date(reservation_date),
        reservationTime: reservation_time,
        status: 'confirmed',
      },
    });
    
    // Vérifier si le restaurant a suffisamment de tables disponibles
    // Cette vérification est simplifiée et pourrait être plus complexe dans un système réel
    const tables = await this.tablesService.findAllForRestaurant(restaurant_id);
    let totalCapacity = 0;
    
    for (const table of tables) {
      totalCapacity += table.capacity;
    }
    
    let reservedCapacity = 0;
    for (const reservation of existingReservations) {
      reservedCapacity += reservation.partySize;
    }
    
    if (reservedCapacity + party_size > totalCapacity) {
      throw new BadRequestException('Désolé, il n\'y a pas assez de places disponibles pour cette date et ce créneau');
    }
    
    // Créer la réservation
    const reservation = this.reservationRepository.create({
      userId,
      restaurantId: restaurant_id,
      reservationDate: new Date(reservation_date),
      reservationTime: reservation_time,
      partySize: party_size,
      status: 'pending',
      specialRequests: createReservationDto.special_requests,
    });
    
    return this.reservationRepository.save(reservation);
  }

  /**
   * Récupère toutes les réservations d'un utilisateur
   * @param userId ID de l'utilisateur
   * @returns Liste des réservations
   */
  async findAllForUser(userId: string): Promise<TableReservation[]> {
    return this.reservationRepository.find({
      where: { userId },
      relations: ['restaurant'],
      order: {
        reservationDate: 'DESC',
        reservationTime: 'DESC',
      },
    });
  }

  /**
   * Récupère toutes les réservations pour un restaurant
   * @param restaurantId ID du restaurant
   * @param date Date optionnelle pour filtrer
   * @returns Liste des réservations
   */
  async findAllForRestaurant(restaurantId: string, date?: string): Promise<TableReservation[]> {
    const queryOptions: any = {
      where: { restaurantId: restaurantId },
      relations: ['user'],
      order: {
        reservationDate: 'ASC',
        reservationTime: 'ASC',
      },
    };
    
    if (date) {
      queryOptions.where.reservationDate = new Date(date);
    }
    
    return this.reservationRepository.find(queryOptions);
  }

  /**
   * Récupère une réservation par son ID
   * @param id ID de la réservation
   * @returns La réservation trouvée
   */
  async findOne(id: string): Promise<TableReservation> {
    const reservation = await this.reservationRepository.findOne({
      where: { id },
      relations: ['restaurant', 'user'],
    });
    
    if (!reservation) {
      throw new NotFoundException(`Réservation avec l'ID ${id} non trouvée`);
    }
    
    return reservation;
  }

  /**
   * Met à jour le statut d'une réservation
   * @param id ID de la réservation
   * @param status Nouveau statut
   * @returns La réservation mise à jour
   */
  async updateStatus(id: string, status: 'pending' | 'confirmed' | 'cancelled'): Promise<TableReservation> {
    const reservation = await this.findOne(id);
    
    reservation.status = status;
    
    return this.reservationRepository.save(reservation);
  }

  /**
   * Annule une réservation
   * @param id ID de la réservation
   * @param userId ID de l'utilisateur (pour vérification)
   * @returns Message de confirmation
   */
  async cancel(id: string, userId: string): Promise<{ message: string }> {
    const reservation = await this.findOne(id);
    
    // Vérifier que l'utilisateur est bien le propriétaire de la réservation
    if (reservation.userId !== userId) {
      throw new BadRequestException('Vous n\'êtes pas autorisé à annuler cette réservation');
    }
    
    // Vérifier que la réservation n'est pas déjà annulée
    if (reservation.status === 'cancelled') {
      throw new BadRequestException('Cette réservation est déjà annulée');
    }
    
    reservation.status = 'cancelled';
    await this.reservationRepository.save(reservation);
    
    return { message: 'Réservation annulée avec succès' };
  }

  /**
   * Récupère les réservations à venir pour un utilisateur
   * @param userId ID de l'utilisateur
   * @returns Liste des réservations à venir
   */
  async findUpcomingForUser(userId: string): Promise<TableReservation[]> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    return this.reservationRepository.find({
      where: {
        userId,
        reservationDate: Between(today, new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000)), // 30 jours à partir d'aujourd'hui
        status: 'confirmed',
      },
      relations: ['restaurant'],
      order: {
        reservationDate: 'ASC',
        reservationTime: 'ASC',
      },
    });
  }
}
