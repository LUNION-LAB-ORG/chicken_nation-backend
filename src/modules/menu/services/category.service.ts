import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CreateCategoryDto } from 'src/modules/menu/dto/create-category.dto';
import { UpdateCategoryDto } from 'src/modules/menu/dto/update-category.dto';
import { PrismaService } from 'src/database/services/prisma.service';
import { EntityStatus, User } from '@prisma/client';
import { CategoryEvent } from 'src/modules/menu/events/category.event';
import type { Request } from 'express';
import { S3Service } from '../../../s3/s3.service';
import { GenerateDataService } from 'src/common/services/generate-data.service';

@Injectable()
export class CategoryService {
  constructor(
    private prisma: PrismaService,
    private categoryEvent: CategoryEvent,
    private readonly s3service: S3Service,
    private readonly generateDataService: GenerateDataService,
  ) { }

  private async uploadImage(image: Express.Multer.File) {
    return await this.s3service.uploadFile({
      buffer: image.buffer,
      path: 'chicken-nation/categories',
      originalname: image.originalname,
      mimetype: image.mimetype,
    });
  }

  async create(
    req: Request,
    createCategoryDto: CreateCategoryDto,
    image: Express.Multer.File,
  ) {
    const user = req.user as User;

    const result = await this.uploadImage(image)

    const category = await this.prisma.category.create({
      data: {
        ...createCategoryDto,
        entity_status: EntityStatus.ACTIVE,
        image: result?.key,
        reference: this.generateDataService.generateReference(createCategoryDto.name),
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

  async findAll(query: { all: boolean } = { all: false }) {
    return this.prisma.category.findMany({
      where: {
        private: query.all ? undefined : false,
        entity_status: EntityStatus.ACTIVE,
      },
      orderBy: {
        name: 'asc',
      },
    });
  }

  async findOne(id: string) {
    if (!id) {
      throw new NotFoundException(`Catégorie non trouvée`);
    }
    const category = await this.prisma.category.findFirst({
      where: { OR: [{ reference: id }, { id }] },
      include: {
        dishes: {
          where: { entity_status: EntityStatus.ACTIVE },
          orderBy: {
            created_at: 'desc',
          },
          include: {
            dish_supplements: {
              include: {
                supplement: true,
              },
            },
          },
        },
      },
    });

    if (!category || category.entity_status !== EntityStatus.ACTIVE) {
      throw new NotFoundException(`Catégorie non trouvée`);
    }

    return category;
  }

  async update(
    req: Request,
    id: string,
    updateCategoryDto: UpdateCategoryDto,
    image: Express.Multer.File,
  ) {
    const category = await this.findOne(id);

    const result = await this.uploadImage(image);

    const categoryUpdated = await this.prisma.category.update({
      where: { id: category.id },
      data: {
        ...updateCategoryDto,
        image: result?.key,
      },
    });

    // Émettre l'événement de mise à jour de catégorie
    this.categoryEvent.updateCategory(categoryUpdated);

    return categoryUpdated;
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
      where: { id: category.id },
      data: {
        entity_status: EntityStatus.DELETED,
      },
    });
  }
}
