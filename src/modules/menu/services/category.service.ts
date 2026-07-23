import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CreateCategoryDto } from 'src/modules/menu/dto/create-category.dto';
import { UpdateCategoryDto } from 'src/modules/menu/dto/update-category.dto';
import { PrismaService } from 'src/database/services/prisma.service';
import { Customer, EntityStatus, Prisma, User } from '@prisma/client';
import { CategoryEvent } from 'src/modules/menu/events/category.event';
import type { Request } from 'express';
import { S3Service } from '../../../s3/s3.service';
import { GenerateDataService } from 'src/common/services/generate-data.service';
import { DishService } from 'src/modules/menu/services/dish.service';
import { AudienceContext, dishAudienceClause } from '../utils/dish-audience.util';

@Injectable()
export class CategoryService {
  private readonly logger = new Logger(CategoryService.name);

  constructor(
    private prisma: PrismaService,
    private categoryEvent: CategoryEvent,
    private readonly s3service: S3Service,
    private readonly generateDataService: GenerateDataService,
    private readonly dishService: DishService,
  ) { }

  /** Passe-plat vers {@link DishService.resolveAudience} (même règle de masque). */
  resolveAudience(principal?: Customer | User, customerId?: string) {
    return this.dishService.resolveAudience(principal, customerId);
  }

  private async uploadImage(image?: Express.Multer.File) {
    if (!image || !image.buffer) return null;
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
      // Compte des plats ACTIFS par catégorie (même filtre que findOne) → le
      // front n'a plus besoin de faire un GET /categories/:id PAR catégorie
      // juste pour compter (N+1).
      include: {
        _count: {
          select: { dishes: { where: { entity_status: EntityStatus.ACTIVE } } },
        },
      },
      orderBy: {
        name: 'asc',
      },
    });
  }

  // `audience.apply` : true uniquement pour la requête APP (client) ou une prise
  // de commande backoffice ciblant un client. Les appels INTERNES (create/update/
  // remove) laissent le défaut `{ apply: false }` → aucun filtre (staff voit tout).
  async findOne(id: string, audience: AudienceContext = { apply: false }) {
    if (!id) {
      throw new NotFoundException(`Catégorie non trouvée`);
    }
    const whereCondition = id.length > 10
      ? { id }
      : { reference: id };

    const dishWhere: Prisma.DishWhereInput = { entity_status: EntityStatus.ACTIVE };
    if (audience.apply) {
      dishWhere.private = false;
      dishWhere.AND = [dishAudienceClause(audience.customer)];
    }

    const category = await this.prisma.category.findFirst({
      where: whereCondition,
      include: {
        dishes: {
          where: dishWhere,
          orderBy: {
            created_at: 'desc',
          },
        },
      },
    });

    if (!category || category.entity_status !== EntityStatus.ACTIVE) {
      throw new NotFoundException(`Catégorie non trouvée`);
    }

    // Populater chaque plat avec ses suppléments/restaurants effectifs (modèle exclusion)
    // + excluded_supplement_ids / excluded_restaurant_ids. Sans ça, les consumers (modal
    // création de commande, etc.) reçoivent des dishes "nus" sans dish_supplements.
    const dishesWithEffective = await this.dishService.withEffective(category.dishes);
    return { ...category, dishes: dishesWithEffective };
  }

  async update(
    req: Request,
    id: string,
    updateCategoryDto: UpdateCategoryDto,
    image?: Express.Multer.File,
  ) {
    const category = await this.findOne(id);

    const result = await this.uploadImage(image);

    const categoryUpdated = await this.prisma.category.update({
      where: { id: category.id },
      data: {
        ...updateCategoryDto,
        ...(result?.key ? { image: result.key } : {}),
      },
    });

    // Chaque upload crée une clé NOUVELLE (`path/<timestamp>-nom`) : sans ce
    // nettoyage, l'ancien visuel resterait sur S3 indéfiniment à chaque
    // changement d'image. Best-effort APRÈS commit — un échec S3 ne doit
    // jamais faire échouer la mise à jour de la catégorie.
    if (result?.key && category.image && category.image !== result.key) {
      this.s3service
        .deleteFile(category.image)
        .catch((e) =>
          this.logger.warn(`Ancienne image catégorie non supprimée (${category.image}) : ${e?.message}`),
        );
    }

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

    const categoryDeleted = await this.prisma.category.update({
      where: { id: category.id },
      data: {
        entity_status: EntityStatus.DELETED,
      },
    });

    this.categoryEvent.deleteCategory(categoryDeleted);

    return categoryDeleted;
  }
}
