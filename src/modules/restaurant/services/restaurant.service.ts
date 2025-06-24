import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { EntityStatus, Restaurant, User, UserRole, UserType } from '@prisma/client';
import { GenerateDataService } from 'src/common/services/generate-data.service';
import { PrismaService } from 'src/database/services/prisma.service';
import { CreateRestaurantDto } from 'src/modules/restaurant/dto/create-restaurant.dto';
import { UpdateRestaurantDto } from 'src/modules/restaurant/dto/update-restaurant.dto';
import { QueryResponseDto } from 'src/common/dto/query-response.dto';
import { RestaurantEvent } from '../events/restaurant.event';
import {
  format,
  getDay,
  isAfter,
  isBefore,
  isEqual,
  parse,
  isValid
} from 'date-fns';
import { Request } from 'express';

@Injectable()
export class RestaurantService {
  constructor(private readonly prisma: PrismaService,
    private readonly generateDataService: GenerateDataService,
    private readonly restaurantEvent: RestaurantEvent,
  ) { }

  /**
   * Création d'un nouveau restaurant et de son gestionnaire
   */
  async create(req: Request, createRestaurantDto: CreateRestaurantDto) {
    const user = req.user as User;
    // Vérifie si un utilisateur avec l'email du gestionnaire existe déjà
    const existingUser = await this.prisma.user.findUnique({
      where: { email: createRestaurantDto.managerEmail }
    });

    if (existingUser) {
      throw new ConflictException(`Utilisateur avec l'email ${createRestaurantDto.managerEmail} existe déjà`);
    }

    const password = this.generateDataService.generateSecurePassword();
    const salt = await bcrypt.genSalt();
    const hashedPassword = await bcrypt.hash(password, salt);

    // Création du restaurant et du gestionnaire dans une transaction
    const result = await this.prisma.$transaction(async (prisma) => {
      // Création du gestionnaire
      const manager = await prisma.user.create({
        data: {
          fullname: createRestaurantDto.managerFullname,
          email: createRestaurantDto.managerEmail,
          phone: createRestaurantDto.managerPhone,
          password: hashedPassword,
          type: UserType.RESTAURANT,
          role: UserRole.MANAGER,
          entity_status: EntityStatus.ACTIVE,
        },
      });

      // Création du restaurant
      const restaurant = await prisma.restaurant.create({
        data: {
          name: createRestaurantDto.name,
          manager: manager.id,
          description: createRestaurantDto.description,
          image: createRestaurantDto.image,
          address: createRestaurantDto.address,
          latitude: createRestaurantDto.latitude,
          longitude: createRestaurantDto.longitude,
          phone: createRestaurantDto.phone,
          email: createRestaurantDto.email,
          schedule: createRestaurantDto.schedule,
          entity_status: EntityStatus.ACTIVE,
          // Ajout du gestionnaire comme utilisateur du restaurant
          users: {
            connect: {
              id: manager.id
            }
          }
        },
      });

      return { restaurant, plainPassword: password };
    });

    // Supprimer les données sensibles avant de retourner
    const { plainPassword } = result;
    const { restaurant } = result;

    // Emettre l'événement de création de restaurant
    this.restaurantEvent.restaurantCreatedEvent({
      actor: { ...user, restaurant: null },
      restaurant: restaurant
    });

    return {
      restaurant,
      managerCredentials: {
        email: createRestaurantDto.managerEmail,
        password: plainPassword
      }
    };
  }

  /**
   * Récupérer tous les restaurants
   */
  async findAll(page = 1, limit = 10): Promise<QueryResponseDto<Restaurant>> {
    const skip = (page - 1) * limit;

    const [restaurants, total] = await Promise.all([
      this.prisma.restaurant.findMany({
        where: {
          entity_status: { not: EntityStatus.DELETED }
        },
        skip,
        take: limit,
        orderBy: { created_at: 'desc' },
      }),
      this.prisma.restaurant.count({
        where: {
          entity_status: { not: EntityStatus.DELETED }
        }
      }),
    ]);

    return {
      data: restaurants,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Obtenir un restaurant par ID
   */
  async findOne(id: string) {
    const restaurant = await this.prisma.restaurant.findFirst({
      where: {
        id,
        entity_status: { not: EntityStatus.DELETED }
      },
      include: {
        users: true,
        dish_restaurants: true
      }
    });

    if (!restaurant) {
      throw new NotFoundException(`Restaurant with ID ${id} not found`);
    }

    return restaurant;
  }

  /**
   * Mettre à jour un restaurant
   */
  async update(id: string, updateRestaurantDto: UpdateRestaurantDto) {
    // Vérifie si le restaurant existe
    await this.findOne(id);

    const updatedRestaurant = await this.prisma.restaurant.update({
      where: { id },
      data: updateRestaurantDto,
    });

    // Emettre l'événement de mise à jour de restaurant
    this.restaurantEvent.restaurantUpdatedEvent(updatedRestaurant);

    return updatedRestaurant;
  }

  /**
   * Activer et Désactiver un restaurant
   */
  async activateDeactivate(id: string) {
    const restaurant = await this.findOne(id);

    const updatedRestaurant = await this.prisma.restaurant.update({
      where: { id },
      data: { entity_status: restaurant.entity_status === EntityStatus.ACTIVE ? EntityStatus.INACTIVE : EntityStatus.ACTIVE },
    });

    // Emettre l'événement de activation/désactivation de restaurant
    restaurant.entity_status === EntityStatus.ACTIVE
      ? this.restaurantEvent.restaurantDeactivatedEvent(updatedRestaurant)
      : this.restaurantEvent.restaurantReactivatedEvent(updatedRestaurant);

    return updatedRestaurant;
  }

  /**
   * Supprimer un restaurant (soft delete)
   */
  async remove(id: string) {

    const deletedRestaurant = await this.prisma.restaurant.update({
      where: { id },
      data: { entity_status: EntityStatus.DELETED },
    });

    // Emettre l'événement de suppression de restaurant
    this.restaurantEvent.restaurantDeletedEvent(deletedRestaurant);

    return deletedRestaurant;
  }

  /**
   * Obtenir tous les utilisateurs (staff) d'un restaurant
   */
  async getRestaurantUsers(id: string) {

    return this.prisma.user.findMany({
      where: {
        restaurant_id: id,
        entity_status: { not: EntityStatus.DELETED },
      },
    });
  }

  /**
   * Obtenir le manager d'un restaurant
   */
  async getRestaurantManager(id: string) {
    const restaurant = await this.findOne(id);

    return this.prisma.user.findUnique({
      where: {
        id: restaurant.manager,
        entity_status: { not: EntityStatus.DELETED },
      },
      select: {
        fullname: true,
        email: true,
        phone: true,
        image: true,
        address: true,
        restaurant_id: true
      }
    });
  }

  /**
 * Vérifie si un restaurant est ouvert selon ses horaires
 * Supporte les formats simples ("08:00-22:00") et multiples ("08:00-12:00,14:00-22:00")
 * @param schedule - Horaires du restaurant au format JSON
 * @param referenceDate - Date de référence (optionnel, par défaut maintenant)
 * @returns boolean - true si ouvert, false si fermé
 */
  public isRestaurantOpen(
    schedule: Record<string, string>[],
    referenceDate: Date = new Date()
  ): boolean {
    if (!schedule || !Array.isArray(schedule)) {
      return false;
    }

    const currentDay = getDay(referenceDate);
    const dayMapping = currentDay === 0 ? 7 : currentDay;

    const todaySchedule = schedule.find(day =>
      day.hasOwnProperty(dayMapping.toString())
    );

    if (!todaySchedule) {
      return false;
    }

    const timeRange = todaySchedule[dayMapping.toString()];

    if (!timeRange ||
      timeRange.toLowerCase() === 'fermé' ||
      timeRange.toLowerCase() === 'closed') {
      return false;
    }

    // Gérer les créneaux multiples séparés par des virgules
    const timeSlots = timeRange.split(',').map(slot => slot.trim());

    return timeSlots.some(slot => {
      const timeRangeParts = slot.split('-');

      if (timeRangeParts.length !== 2) {
        return false;
      }

      const [openTimeStr, closeTimeStr] = timeRangeParts;

      try {
        const baseDate = format(referenceDate, 'yyyy-MM-dd');

        const openTime = parse(`${baseDate} ${openTimeStr.trim()}`, 'yyyy-MM-dd HH:mm', new Date());
        const closeTime = parse(`${baseDate} ${closeTimeStr.trim()}`, 'yyyy-MM-dd HH:mm', new Date());

        if (!isValid(openTime) || !isValid(closeTime)) {
          return false;
        }

        // Gestion du cas après minuit
        if (isBefore(closeTime, openTime)) {
          const nextDayCloseTime = parse(
            `${format(referenceDate, 'yyyy-MM-dd')} ${closeTimeStr.trim()}`,
            'yyyy-MM-dd HH:mm',
            new Date()
          );
          nextDayCloseTime.setDate(nextDayCloseTime.getDate() + 1);

          return (
            (isAfter(referenceDate, openTime) || isEqual(referenceDate, openTime)) ||
            (isBefore(referenceDate, nextDayCloseTime) || isEqual(referenceDate, nextDayCloseTime))
          );
        }

        return (
          (isAfter(referenceDate, openTime) || isEqual(referenceDate, openTime)) &&
          (isBefore(referenceDate, closeTime) || isEqual(referenceDate, closeTime))
        );

      } catch (error) {
        console.warn('Erreur lors du parsing du créneau:', slot, error);
        return false;
      }
    });
  }
}