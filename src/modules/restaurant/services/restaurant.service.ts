import {
  Injectable,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcryptjs';
import {
  EntityStatus,
  Restaurant,
  User,
  UserRole,
  UserType,
} from '@prisma/client';
import { GenerateDataService } from 'src/common/services/generate-data.service';
import { PrismaService } from 'src/database/services/prisma.service';
import { CreateRestaurantDto } from 'src/modules/restaurant/dto/create-restaurant.dto';
import { UpdateRestaurantDto } from 'src/modules/restaurant/dto/update-restaurant.dto';
import { QueryResponseDto } from 'src/common/dto/query-response.dto';
import { RestaurantEvent } from '../events/restaurant.event';
import { ouvertSelonHoraires } from '../utils/horaires-ouverture';
import type { Request } from 'express';
import { S3Service } from '../../../s3/s3.service';
import {
  CLIENT_DE_RESTAURANT_SELECT,
  filtreClientsRestaurant,
  paginationClientsRestaurant,
} from '../utils/clients-restaurant.util';

@Injectable()
export class RestaurantService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly generateDataService: GenerateDataService,
    private readonly restaurantEvent: RestaurantEvent,
    private readonly s3service: S3Service,
  ) {}

  private async uploadImage(image?: Express.Multer.File) {
    if (!image) return null;
    return await this.s3service.uploadFile({
      buffer: image.buffer,
      path: 'chicken-nation/restaurants',
      originalname: image.originalname,
      mimetype: image.mimetype,
    });
  }

  /**
   * Création d'un nouveau restaurant et de son gestionnaire
   */
  async create(req: Request, createRestaurantDto: CreateRestaurantDto, image?: Express.Multer.File) {
    const user = req.user as User;
    // Vérifie si un utilisateur avec l'email du gestionnaire existe déjà
    const existingUser = await this.prisma.user.findUnique({
      where: { email: createRestaurantDto.managerEmail },
    });

    if (existingUser) {
      throw new ConflictException(
        `Utilisateur avec l'email ${createRestaurantDto.managerEmail} existe déjà`,
      );
    }

    const password = this.generateDataService.generateSecurePassword();
    const salt = await bcrypt.genSalt();
    const hashedPassword = await bcrypt.hash(password, salt);

    const uploadResult = await this.uploadImage(image);

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
          image: uploadResult?.key ?? createRestaurantDto.image,
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
              id: manager.id,
            },
          },
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
      restaurant: restaurant,
    });

    return {
      restaurant,
      managerCredentials: {
        email: createRestaurantDto.managerEmail,
        password: plainPassword,
      },
    };
  }

  /**
   * FAILLE CORRIGÉE (audit 31/07) : GET /restaurants et GET /restaurants/:id
   * sont PUBLICS (app cliente, site) mais renvoyaient TOUTES les colonnes —
   * dont la clé API Turbo (`apikey`) et le token OAuth HubRise — et `findOne`
   * incluait `users` AVEC le hash des mots de passe du personnel. N'importe qui
   * sur Internet pouvait les récupérer. Les deux routes ne servent plus que
   * cette LISTE BLANCHE ; les lecteurs internes (Turbo, HubRise) continuent de
   * lire les colonnes sensibles par leurs propres requêtes.
   *
   * Revue 25/09 : `findOne` joignait encore `users` (id, nom, email, rôle,
   * photo de tout le personnel), soit un annuaire public exploitable pour
   * l'hameçonnage et les essais de connexion. Aucun écran ne le lisait : il
   * est retiré. L'annuaire du personnel passe par GET /restaurants/:id/users,
   * gardée PERSONNELS.READ.
   */
  private static readonly PUBLIC_SELECT = {
    id: true,
    name: true,
    manager: true,
    description: true,
    image: true,
    address: true,
    latitude: true,
    longitude: true,
    phone: true,
    email: true,
    schedule: true,
    entity_status: true,
    created_at: true,
    updated_at: true,
  } as const;

  /**
   * Récupérer tous les restaurants
   */
  async findAll(
    page = 1,
    limit = 10,
  ): Promise<
    QueryResponseDto<
      Omit<
        Restaurant,
        'apikey' | 'hubrise_access_token' | 'hubrise_location_id' | 'hubrise_catalog_id' | 'hubrise_customer_list_id'
      > & { rating: number; reviews_count: number; is_open: boolean }
    >
  > {
    const skip = (page - 1) * limit;

    const [restaurants, total] = await Promise.all([
      this.prisma.restaurant.findMany({
        where: {
          entity_status: { not: EntityStatus.DELETED },
        },
        select: RestaurantService.PUBLIC_SELECT,
        skip,
        take: limit,
        orderBy: { created_at: 'desc' },
      }),
      this.prisma.restaurant.count({
        where: {
          entity_status: { not: EntityStatus.DELETED },
        },
      }),
    ]);

    // Enrichissement par resto : note moyenne + nb d'avis (à partir des avis
    // rattachés aux commandes du restaurant) et statut ouvert/fermé (depuis le
    // planning, même logique que le routage de livraison). Agrégats côté DB.
    const data = await Promise.all(
      restaurants.map(async (restaurant) => {
        const reviews = await this.prisma.comment.aggregate({
          where: { order: { restaurant_id: restaurant.id } },
          _avg: { rating: true },
          _count: { rating: true },
        });

        let is_open = false;
        try {
          const schedule = JSON.parse(restaurant.schedule?.toString() ?? '[]');
          is_open = this.isRestaurantOpen(schedule);
        } catch {
          is_open = false;
        }

        return {
          ...restaurant,
          // Note arrondie à 1 décimale (0 si aucun avis).
          rating: reviews._avg.rating
            ? Math.round(reviews._avg.rating * 10) / 10
            : 0,
          reviews_count: reviews._count.rating,
          is_open,
        };
      }),
    );

    return {
      data,
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
        entity_status: { not: EntityStatus.DELETED },
      },
      // Route publique (invités de l'appli cliente) : liste blanche seule,
      // jamais le personnel ni les secrets Turbo / HubRise.
      select: RestaurantService.PUBLIC_SELECT,
    });

    if (!restaurant) {
      throw new NotFoundException(`Restaurant with ID ${id} not found`);
    }

    return restaurant;
  }

  /**
   * Mettre à jour un restaurant
   */
  async update(id: string, updateRestaurantDto: UpdateRestaurantDto, image?: Express.Multer.File) {
    // Vérifie si le restaurant existe
    await this.findOne(id);

    const uploadResult = await this.uploadImage(image);

    // Liste blanche aussi sur la MUTATION (revue 31/07) : la réponse ET
    // l'événement émis (relayé en WebSocket) ne doivent jamais transporter
    // apikey Turbo / tokens HubRise — vecteur exact de l'ancienne fuite WS.
    const updatedRestaurant = await this.prisma.restaurant.update({
      where: { id },
      data: {
        ...updateRestaurantDto,
        image: uploadResult?.key ?? updateRestaurantDto.image,
      },
      select: RestaurantService.PUBLIC_SELECT,
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
      data: {
        entity_status:
          restaurant.entity_status === EntityStatus.ACTIVE
            ? EntityStatus.INACTIVE
            : EntityStatus.ACTIVE,
      },
      select: RestaurantService.PUBLIC_SELECT,
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
      select: RestaurantService.PUBLIC_SELECT,
    });

    // Emettre l'événement de suppression de restaurant
    this.restaurantEvent.restaurantDeletedEvent(deletedRestaurant);

    return deletedRestaurant;
  }

  /**
   * Obtenir tous les utilisateurs (staff) d'un restaurant
   */
  async getRestaurantUsers(id: string) {
    // Champs d'affichage uniquement — JAMAIS le hash de mot de passe, même
    // pour un staff autorisé (revue 31/07).
    return this.prisma.user.findMany({
      where: {
        restaurant_id: id,
        entity_status: { not: EntityStatus.DELETED },
      },
      select: {
        id: true,
        fullname: true,
        email: true,
        role: true,
        type: true,
        image: true,
        restaurant_id: true,
        entity_status: true,
        created_at: true,
        updated_at: true,
      },
    });
  }

  /**
   * Clients d'un restaurant, pour la liste déroulante des fenêtres « Nouvelle
   * conversation » et « Nouveau ticket » du backoffice.
   *
   * Une page de 50 (100 au plus), recherche faite par la base, clients actifs
   * seulement, et rien d'autre que nom, e-mail, téléphone et photo. Réponse en
   * tableau simple, la forme qu'attendent les écrans. Voir
   * `clients-restaurant.util.ts`.
   */
  async getRestaurantCustomers(
    id: string,
    params: { search?: string; page?: string | number; limit?: string | number } = {},
  ) {
    const { skip, limit } = paginationClientsRestaurant(params.page, params.limit);
    return this.prisma.customer.findMany({
      where: filtreClientsRestaurant(id, params.search),
      select: CLIENT_DE_RESTAURANT_SELECT,
      orderBy: [{ first_name: 'asc' }, { last_name: 'asc' }, { id: 'asc' }],
      skip,
      take: limit,
    });
  }

  /**
   * Obtenir le manager d'un restaurant
   */
  async getRestaurantManager(id: string) {
    const restaurant = await this.findOne(id);

    // Restaurant sans gérant désigné : rien à renvoyer. `findUnique` avec un
    // identifiant absent levait une erreur Prisma (réponse 500).
    if (!restaurant.manager) return null;

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
        restaurant_id: true,
      },
    });
  }

  /**
   * Vérifie si un restaurant est ouvert selon ses horaires
   * Supporte les formats simples ("08:00-22:00") et multiples ("08:00-12:00,14:00-22:00"),
   * et la fermeture après minuit ("22:00-02:00"). Règle : utils/horaires-ouverture.ts.
   * @param schedule - Horaires du restaurant au format JSON
   * @param referenceDate - Date de référence (optionnel, par défaut maintenant)
   * @returns boolean - true si ouvert, false si fermé
   */
  public isRestaurantOpen(
    schedule: Record<string, string>[],
    referenceDate: Date = new Date(),
  ): boolean {
    return ouvertSelonHoraires(schedule, referenceDate);
  }
}
