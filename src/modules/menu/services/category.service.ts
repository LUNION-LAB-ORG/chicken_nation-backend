import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { CreateCategoryDto } from 'src/modules/menu/dto/create-category.dto';
import { UpdateCategoryDto } from 'src/modules/menu/dto/update-category.dto';
import { PrismaService } from 'src/database/services/prisma.service';
import { EntityStatus, User } from '@prisma/client';
import { CategoryEvent } from 'src/modules/menu/events/category.event';
import { Request } from 'express';

@Injectable()
export class CategoryService {
  constructor(private prisma: PrismaService,
    private categoryEvent: CategoryEvent
  ) { }

  async create(req: Request, createCategoryDto: CreateCategoryDto) {
    const user = req.user as User;
    const category = await this.prisma.category.create({
      data: {
        ...createCategoryDto,
        entity_status: EntityStatus.ACTIVE,
      },
    });

    // Émettre l'événement de création de catégorie
    this.categoryEvent.createCategory({
      actor: {
        ...user,
        restaurant: null,
      },
      category,
    });

    return category;
  }

  async findAll() {
    return this.prisma.category.findMany({
      where: {
        entity_status: EntityStatus.ACTIVE,
      },
      orderBy: {
        name: 'asc',
      },
    });
  }

  async findOne(id: string) {
    const category = await this.prisma.category.findUnique({
      where: { id },
      include: {
        dishes: {
          where: { entity_status: EntityStatus.ACTIVE },
        },
      },
    });

    if (!category || category.entity_status !== EntityStatus.ACTIVE) {
      throw new NotFoundException(`Catégorie non trouvée`);
    }

    return category;
  }

  async update(req: Request, id: string, updateCategoryDto: UpdateCategoryDto) {
    const user = req.user as User;
    await this.findOne(id);

    const category = await this.prisma.category.update({
      where: { id },
      data: updateCategoryDto,
    });

    // Émettre l'événement de mise à jour de catégorie
    this.categoryEvent.updateCategory(category);

    return category;
  }

  async remove(id: string) {
    const category = await this.findOne(id);

    // Vérifier si la catégorie est liée à des plats
    if (category.dishes && category.dishes.length > 0) {
      throw new BadRequestException(
        `Catégorie ${category.name} non supprimée car liée à ${category.dishes.length} plats`,
      );
    }

    return this.prisma.category.update({
      where: { id },
      data: {
        entity_status: EntityStatus.DELETED,
      },
    });
  }
}
