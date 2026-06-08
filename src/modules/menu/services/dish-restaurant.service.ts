import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/database/services/prisma.service';
import { CreateDishRestaurantDto } from 'src/modules/menu/dto/create-dish-restaurant.dto';

@Injectable()
export class DishRestaurantService {
  constructor(private prisma: PrismaService) { }

  async create(createDishRestaurantDto: CreateDishRestaurantDto) {
    return this.prisma.dishExcludedRestaurant.create({
      data: createDishRestaurantDto,
      include: {
        dish: true,
        restaurant: true,
      },
    });
  }

  async findAll() {
    return this.prisma.dishExcludedRestaurant.findMany({
      include: {
        dish: true,
        restaurant: true,
      },
    });
  }

  async findByDish(dishId: string) {
    return this.prisma.dishExcludedRestaurant.findMany({
      where: {
        dish_id: dishId,
      },
      include: {
        restaurant: true,
      },
    });
  }

  async findByRestaurant(restaurantId: string) {
    return this.prisma.dishExcludedRestaurant.findMany({
      where: {
        restaurant_id: restaurantId,
      },
      include: {
        dish: {
          include: {
            category: true,
          },
        },
      },
    });
  }

  async remove(id: string) {
    const dishRestaurant = await this.prisma.dishExcludedRestaurant.findUnique({
      where: { id },
    });

    if (!dishRestaurant) {
      throw new NotFoundException(`Dish-Restaurant non trouvé`);
    }

    return this.prisma.dishExcludedRestaurant.delete({
      where: { id },
    });
  }

  async removeByDishAndRestaurant(dishId: string, restaurantId: string) {
    return this.prisma.dishExcludedRestaurant.deleteMany({
      where: {
        dish_id: dishId,
        restaurant_id: restaurantId,
      },
    });
  }
}
