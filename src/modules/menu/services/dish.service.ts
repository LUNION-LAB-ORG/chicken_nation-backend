import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Dish, EntityStatus, Prisma, User } from '@prisma/client';
import { Request } from 'express';
import { QueryResponseDto } from 'src/common/dto/query-response.dto';
import { PrismaService } from 'src/database/services/prisma.service';
import { CreateDishDto } from 'src/modules/menu/dto/create-dish.dto';
import { UpdateDishDto } from 'src/modules/menu/dto/update-dish.dto';
import { DishEvent } from 'src/modules/menu/events/dish.event';
import { QueryDishDto } from '../dto/query-dish.dto';
import { S3Service } from '../../../s3/s3.service';

@Injectable()
export class DishService {
  constructor(
    private prisma: PrismaService,
    private dishEvent: DishEvent,
    private readonly s3service: S3Service,
  ) { }

  private async uploadImage(image?: Express.Multer.File) {
    if (!image) return null;
    return await this.s3service.uploadFile({
      buffer: image.buffer,
      path: 'chicken-nation/dishes',
      originalname: image.originalname,
      mimetype: image.mimetype,
    });
  }

  async create(req: Request, createDishDto: CreateDishDto, image?: Express.Multer.File) {
    const user = req.user as User;
    const { restaurant_ids, supplement_ids, ...dishData } = createDishDto;

    const uploadResult = await this.uploadImage(image);

    // Créer le plat de base
    const dish = await this.prisma.dish.create({
      data: {
        ...dishData,
        image: uploadResult?.key ?? dishData.image,
        entity_status: EntityStatus.ACTIVE,
      },
    });

    // Ajouter les restaurants si fournis
    if (restaurant_ids) {
      let restaurants = restaurant_ids;
      if (typeof restaurant_ids === 'string') {
        restaurants = [restaurant_ids];
      }
      await this.prisma.dishRestaurant.createMany({
        data: restaurants.map((restaurant_id) => ({
          dish_id: dish.id,
          restaurant_id,
        })),
      });
    }

    // Ajouter les suppléments si fournis
    if (supplement_ids) {
      let supplements = supplement_ids;
      if (typeof supplement_ids === 'string') {
        supplements = [supplement_ids];
      }
      await this.prisma.dishSupplement.createMany({
        data: supplements.map((supplement_id) => ({
          dish_id: dish.id,
          supplement_id,
        })),
      });
    }

    // Émettre l'événement de création de plat
    this.dishEvent.createDish({
      actor: {
        ...user,
        restaurant: null,
      },
      dish,
    });

    return this.findOne(dish.id);
  }

  async findAll(query: { all: boolean } = { all: false }) {
    return this.prisma.dish.findMany({
      where: {
        private: query.all ? undefined : false,
        entity_status: EntityStatus.ACTIVE,
      },
      include: {
        category: true,
        dish_restaurants: {
          include: {
            restaurant: true,
          },
        },
        dish_supplements: {
          include: {
            supplement: true,
          },
        },
      },
      orderBy: {
        name: 'asc',
      },
    });
  }

  async findMany(filter: QueryDishDto): Promise<QueryResponseDto<Dish>> {
    const { search, status, categoryId, minPrice, maxPrice, page = 1, limit = 10, sortBy = "name", sortOrder = "asc" } = filter;

    const where: Prisma.DishWhereInput = {
      entity_status: EntityStatus.ACTIVE,
    };
    //  name ou description
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
      ];
    }
    if (status) {
      where.entity_status = status;
    }
    if (categoryId) {
      where.category_id = categoryId;
    }
    if (minPrice) {
      where.price = {
        gte: minPrice,
      };
    }
    if (maxPrice) {
      where.price = {
        lte: maxPrice,
      };
    }

    const [count, dishes] = await Promise.all([
      this.prisma.dish.count({
        where,
      }),
      this.prisma.dish.findMany({
        where,
        include: {
          category: true,
          dish_restaurants: {
            include: {
              restaurant: true,
            },
          },
          dish_supplements: {
            include: {
              supplement: true,
            },
          },
        },
        orderBy: {
          // name: 'asc',
          [sortBy]: sortOrder,
        },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return {
      data: dishes,
      meta: {
        total: count,
        page,
        limit,
        totalPages: Math.ceil(count / limit),
      },
    };
  }

  async findOne(id: string) {
    const dish = await this.prisma.dish.findUnique({
      where: { id },
      include: {
        category: true,
        dish_restaurants: {
          include: {
            restaurant: true,
          },
        },
        dish_supplements: {
          include: {
            supplement: true,
          },
        },
      },
    });

    if (!dish || dish.entity_status !== EntityStatus.ACTIVE) {
      throw new NotFoundException(`Plat non trouvée`);
    }

    return dish;
  }

  async update(req: Request, id: string, updateDishDto: UpdateDishDto, image?: Express.Multer.File) {
    const user = req.user as User;
    await this.findOne(id);

    const uploadResult = await this.uploadImage(image);

    const dish = await this.prisma.dish.update({
      where: { id },
      data: {
        ...updateDishDto,
        image: uploadResult?.key ?? updateDishDto.image,
      },
    });

    // Émettre l'événement de mise à jour de plat
    this.dishEvent.updateDish(dish);

    return dish;
  }

  async remove(id: string) {
    // Vérifier si le plat existe
    const dish = await this.findOne(id);

    // Vérifier si le plat est lié à des commandes
    const orderItems = await this.prisma.orderItem.findMany({
      where: {
        dish_id: id,
      },
    });

    if (orderItems.length > 0) {
      throw new BadRequestException(
        `Vous ne pouvez pas supprimer le plat ${dish.name} car il est lié à ${orderItems.length} commandes`,
      );
    }

    // Supprimer les relations avec les restaurants
    await this.prisma.dishRestaurant.deleteMany({
      where: {
        dish_id: id,
      },
    });

    // Supprimer les relations avec les suppléments
    await this.prisma.dishSupplement.deleteMany({
      where: {
        dish_id: id,
      },
    });

    // Supprimer le plat (soft delete)
    return this.prisma.dish.update({
      where: { id },
      data: {
        entity_status: EntityStatus.DELETED,
      },
    });
  }
}
