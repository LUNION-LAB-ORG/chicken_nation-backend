import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityStatus } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { CreateDishDto } from 'src/modules/menu/dto/create-dish.dto';
import { UpdateDishDto } from 'src/modules/menu/dto/update-dish.dto';

@Injectable()
export class DishService {
  constructor(private prisma: PrismaService) { }

  async create(createDishDto: CreateDishDto) {
    const { restaurant_ids, supplement_ids, ...dishData } = createDishDto;

    // Créer le plat de base
    const dish = await this.prisma.dish.create({
      data: {
        ...dishData,
        entity_status: EntityStatus.ACTIVE,
      },
    });

    // Ajouter les restaurants si fournis
    if (restaurant_ids) {
      let restaurants = restaurant_ids;
      if(typeof restaurant_ids === 'string') {
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
      if(typeof supplement_ids === 'string') {
        supplements = [supplement_ids];
      }
      await this.prisma.dishSupplement.createMany({
        data: supplements.map((supplement_id) => ({
          dish_id: dish.id,
          supplement_id,
        })),
      });
    }

    return this.findOne(dish.id);
  }

  async findAll() {
    return this.prisma.dish.findMany({
      where: {
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

  async update(id: string, updateDishDto: UpdateDishDto) {
    await this.findOne(id);

    return this.prisma.dish.update({
      where: { id },
      data: updateDishDto,
    });
  }

  async remove(id: string) {
    // Vérifier si le plat existe
    const dish = await this.findOne(id);

    // Vérifier si le plat est lié à des commandes
    const orderItems = await this.prisma.orderItem.findMany({
      where: {
        dish_id: id,
        entity_status: EntityStatus.ACTIVE,
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
