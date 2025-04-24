import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/database/services/prisma.service';
import { CreateDishSupplementDto } from 'src/modules/menu/dto/create-dish-supplement.dto';

@Injectable()
export class DishSupplementService {
  constructor(private prisma: PrismaService) { }

  async create(createDishSupplementDto: CreateDishSupplementDto) {
    return this.prisma.dishSupplement.create({
      data: createDishSupplementDto,
      include: {
        dish: true,
        supplement: true,
      },
    });
  }

  async findAll() {
    return this.prisma.dishSupplement.findMany({
      include: {
        dish: true,
        supplement: true,
      },
    });
  }

  async remove(id: string) {
    const dishSupplement = await this.prisma.dishSupplement.findUnique({
      where: { id },
    });

    if (!dishSupplement) {
      throw new NotFoundException(`Dish-Supplement non trouvé`);
    }

    return this.prisma.dishSupplement.delete({
      where: { id },
    });
  }

  async removeByDishAndSupplement(dishId: string, supplementId: string) {
    return this.prisma.dishSupplement.deleteMany({
      where: {
        dish_id: dishId,
        supplement_id: supplementId,
      },
    });
  }
}
