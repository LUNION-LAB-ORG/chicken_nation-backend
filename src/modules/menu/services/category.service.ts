import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CreateCategoryDto } from 'src/modules/menu/dto/create-category.dto';
import { parIdentifiantOuReference } from 'src/common/utils/identifiant.util';
import { UpdateCategoryDto } from 'src/modules/menu/dto/update-category.dto';
import { PrismaService } from 'src/database/services/prisma.service';
import { Customer, EntityStatus, Prisma, User } from '@prisma/client';
import { CategoryEvent } from 'src/modules/menu/events/category.event';
import type { Request } from 'express';
import { S3Service } from '../../../s3/s3.service';
import { GenerateDataService } from 'src/common/services/generate-data.service';
import { DishService } from 'src/modules/menu/services/dish.service';
import { AudienceContext, composableClause, dishAudienceClause } from '../utils/dish-audience.util';
import { PLAT_EN_PROMOTION, porteeCategorie } from '../utils/vitrine-promotions.util';

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
  resolveAudience(principal?: Customer | User, customerId?: string, headers?: unknown) {
    return this.dishService.resolveAudience(principal, customerId, headers);
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
    const categories = await this.prisma.category.findMany({
      where: {
        private: query.all ? undefined : false,
        entity_status: EntityStatus.ACTIVE,
      },
      // Compte des plats ACTIFS par catégorie (même filtre que findOne) → le
      // front n'a plus besoin de faire un GET /categories/:id PAR catégorie
      // juste pour compter (N+1).
      include: {
        _count: {
          select: {
            dishes: {
              where: {
                entity_status: EntityStatus.ACTIVE,
                // Verrou composable jusque dans le COMPTEUR : sans lui, une
                // catégorie annoncerait « 12 plats » à une application qui n'en
                // afficherait que 11. Le backoffice (`all`) les compte, lui.
                ...(query.all ? {} : { composable: false }),
              },
            },
          },
        },
      },
      orderBy: {
        name: 'asc',
      },
    });

    // Le compteur ci-dessus ne sait compter que la RELATION. Une vitrine de
    // promotions annoncerait donc le nombre de plats qu'on y a déplacés à la
    // main, souvent zéro, alors qu'elle en présente vingt. On ajoute les
    // promotions rattachées ailleurs.
    const vitrines = categories.filter((categorie) => categorie.auto_promotions);
    if (vitrines.length > 0) {
      const filtreCommun: Prisma.DishWhereInput = {
        entity_status: EntityStatus.ACTIVE,
        // Même verrou composable que le compteur de la relation, sinon la
        // vitrine annoncerait des plats que l'application n'affiche pas.
        ...(query.all ? {} : { composable: false }),
        ...PLAT_EN_PROMOTION,
      };
      await Promise.all(
        vitrines.map(async (categorie) => {
          const horsCategorie = await this.prisma.dish.count({
            where: { ...filtreCommun, NOT: { category_id: categorie.id } },
          });
          categorie._count.dishes += horsCategorie;
        }),
      );
    }

    return categories;
  }

  // `audience.apply` : true uniquement pour la requête APP (client) ou une prise
  // de commande backoffice ciblant un client. Les appels INTERNES (create/update/
  // remove) laissent le défaut `{ apply: false }` → aucun filtre (staff voit tout).
  async findOne(id: string, audience: AudienceContext = { apply: false }) {
    if (!id) {
      throw new NotFoundException(`Catégorie non trouvée`);
    }
    const whereCondition = parIdentifiantOuReference(id);

    const dishWhere: Prisma.DishWhereInput = {
      entity_status: EntityStatus.ACTIVE,
      // Verrou composable, appliqué même quand le masque d'audience ne l'est
      // pas : cette route sert la carte à l'application cliente.
      ...composableClause(audience),
    };
    if (audience.apply) {
      dishWhere.private = false;
      dishWhere.AND = [dishAudienceClause(audience.customer)];
    }

    const category = await this.prisma.category.findFirst({
      where: whereCondition,
    });

    if (!category || category.entity_status !== EntityStatus.ACTIVE) {
      throw new NotFoundException(`Catégorie non trouvée`);
    }

    // Les plats sont demandés à part, et non plus par `include`, parce qu'une
    // vitrine de promotions n'est justement PAS la relation : elle rassemble
    // aussi des plats rattachés ailleurs. Voir `vitrine-promotions.util`.
    const dishes = await this.prisma.dish.findMany({
      where: {
        ...dishWhere,
        ...porteeCategorie(category.id, category.auto_promotions),
      },
      orderBy: { created_at: 'desc' },
    });

    // Populater chaque plat avec ses suppléments/restaurants effectifs (modèle exclusion)
    // + excluded_supplement_ids / excluded_restaurant_ids. Sans ça, les consumers (modal
    // création de commande, etc.) reçoivent des dishes "nus" sans dish_supplements.
    const dishesWithEffective = await this.dishService.withEffective(dishes);
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

    // Compte demandé à la RELATION, et surtout pas à `category.dishes` : sur une
    // vitrine de promotions, cette liste contient des plats rattachés ailleurs,
    // qui n'empêchent en rien de la supprimer. S'y fier rendrait la vitrine
    // indéracinable dès qu'une promotion existe quelque part.
    const platsRattaches = await this.prisma.dish.count({
      where: { category_id: category.id, entity_status: EntityStatus.ACTIVE },
    });
    if (platsRattaches > 0) {
      throw new BadRequestException(
        `Catégorie ${category.name} non supprimée car liée à ${platsRattaches} plats`,
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
