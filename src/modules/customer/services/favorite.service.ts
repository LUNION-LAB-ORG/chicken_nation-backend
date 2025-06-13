import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from 'src/database/services/prisma.service';
import { CreateFavoriteDto } from 'src/modules/customer/dto/create-favorite.dto';
import { UpdateFavoriteDto } from 'src/modules/customer/dto/update-favorite.dto';
import { EntityStatus, Customer } from '@prisma/client';
import { Request } from 'express';

@Injectable()
export class FavoriteService {
  constructor(private prisma: PrismaService) { }

  async create(req: Request, createFavoriteDto: CreateFavoriteDto) {
    const customer = req.user as Customer;

    // Vérifier si le plat existe
    const dish = await this.prisma.dish.findUnique({
      where: { id: createFavoriteDto.dish_id },
    });

    if (!dish || dish.entity_status !== EntityStatus.ACTIVE) {
      throw new NotFoundException(`Dish with ID ${createFavoriteDto.dish_id} not found`);
    }

    // Vérifier si le favori existe déjà
    const existingFavorite = await this.prisma.favorite.findFirst({
      where: {
        customer_id: customer.id,
        dish_id: createFavoriteDto.dish_id,
      },
    });

    if (existingFavorite) {
      throw new ConflictException(`This dish is already in favorites for this customer`);
    }

    return this.prisma.favorite.create({
      data: {
        ...createFavoriteDto,
        customer_id: customer.id,
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

  async findAll() {
    return this.prisma.favorite.findMany({
      include: {
        customer: true,
        dish: {
          include: {
            category: true,
          },
        },
      },
      orderBy: {
        created_at: 'desc',
      },
    });
  }

  async findOne(id: string) {
    const favorite = await this.prisma.favorite.findUnique({
      where: { id },
      include: {
        customer: true,
        dish: {
          include: {
            category: true,
          },
        },
      },
    });

    if (!favorite) {
      throw new NotFoundException(`Favorite with ID ${id} not found`);
    }

    return favorite;
  }

  async findByCustomer(customerId: string) {
    return this.prisma.favorite.findMany({
      where: {
        customer_id: customerId,
      },
      include: {
        dish: {
          include: {
            category: true,
          },
        },
      },
      orderBy: {
        created_at: 'desc',
      },
    });
  }

  async update(id: string, updateFavoriteDto: UpdateFavoriteDto) {
    // Vérifier si le favori existe
    await this.findOne(id);

    // Vérifier si le plat existe (si fourni)
    if (updateFavoriteDto.dish_id) {
      const dish = await this.prisma.dish.findUnique({
        where: { id: updateFavoriteDto.dish_id },
      });

      if (!dish || dish.entity_status !== EntityStatus.ACTIVE) {
        throw new NotFoundException(`Dish with ID ${updateFavoriteDto.dish_id} not found`);
      }
    }

    return this.prisma.favorite.update({
      where: { id },
      data: updateFavoriteDto,
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
    // Vérifier si le favori existe
    await this.findOne(id);

    // Suppression définitive
    return this.prisma.favorite.delete({
      where: { id },
    });
  }

  async removeByCustomerAndDish(customerId: string, dishId: string) {
    const favorite = await this.prisma.favorite.findFirst({
      where: {
        customer_id: customerId,
        dish_id: dishId,
      },
    });

    if (!favorite) {
      throw new NotFoundException(`Favorite not found for customer ${customerId} and dish ${dishId}`);
    }

    return this.prisma.favorite.delete({
      where: { id: favorite.id },
    });
  }
}