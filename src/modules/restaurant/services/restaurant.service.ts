import { Injectable, ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { EntityStatus, UserRole, UserType } from '@prisma/client';
import { GenerateDataService } from 'src/common/services/generate-data.service';
import { PrismaService } from 'src/database/services/prisma.service';
import { CreateRestaurantDto } from 'src/modules/restaurant/dto/create-restaurant.dto';
import { UpdateRestaurantDto } from 'src/modules/restaurant/dto/update-restaurant.dto';

@Injectable()
export class RestaurantService {
  constructor(private readonly prisma: PrismaService, private readonly generateDataService: GenerateDataService) { }

  /**
   * Création d'un nouveau restaurant et de son gestionnaire
   */
  async create(createRestaurantDto: CreateRestaurantDto) {
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
        include: {
          users: true
        }
      });

      return { restaurant, plainPassword: password };
    });

    // Supprimer les données sensibles avant de retourner
    const { plainPassword } = result;
    const { restaurant } = result;

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
  async findAll(page = 1, limit = 10) {
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
    });

    if (!restaurant) {
      throw new NotFoundException(`Restaurant with ID ${id} not found`);
    }

    return restaurant;
  }

  /**
   * Mettre à jour un restaurant
   */
  async update(id: string, updateRestaurantDto: UpdateRestaurantDto, userId: string) {
    // Vérifie si le restaurant existe
    const restaurant = await this.findOne(id);

    // Vérifie si l'utilisateur est le manager de ce restaurant
    await this.validateManager(id, userId);

    return this.prisma.restaurant.update({
      where: { id },
      data: updateRestaurantDto,
    });
  }

  /**
   * Activer un restaurant
   */
  async activate(id: string, userId: string) {
    await this.validateManager(id, userId);

    return this.prisma.restaurant.update({
      where: { id },
      data: { entity_status: EntityStatus.ACTIVE },
    });
  }

  /**
   * Désactiver un restaurant
   */
  async deactivate(id: string, userId: string) {
    await this.validateManager(id, userId);

    return this.prisma.restaurant.update({
      where: { id },
      data: { entity_status: EntityStatus.INACTIVE },
    });
  }

  /**
   * Supprimer un restaurant (soft delete)
   */
  async remove(id: string, userId: string) {
    await this.validateManager(id, userId);

    return this.prisma.restaurant.update({
      where: { id },
      data: { entity_status: EntityStatus.DELETED },
    });
  }

  /**
   * Obtenir tous les utilisateurs (staff) d'un restaurant
   */
  async getRestaurantUsers(id: string, userId: string) {
    await this.validateManager(id, userId);

    return this.prisma.user.findMany({
      where: {
        restaurant_id: id,
        entity_status: { not: EntityStatus.DELETED },
      },
    });
  }

  /**
   * Méthode de validation pour vérifier si un utilisateur est le manager d'un restaurant
   */
  private async validateManager(restaurantId: string, userId: string) {
    const restaurant = await this.prisma.restaurant.findFirst({
      where: { id: restaurantId },
    });

    if (!restaurant) {
      throw new NotFoundException(`Restaurant with ID ${restaurantId} not found`);
    }

    // Vérifie si l'utilisateur est le manager de ce restaurant
    if (restaurant.manager !== userId) {
      throw new UnauthorizedException('Only the restaurant manager can perform this action');
    }

    return restaurant;
  }
}