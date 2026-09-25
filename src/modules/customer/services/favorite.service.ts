import { Injectable, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from 'src/database/services/prisma.service';
import { CreateFavoriteDto } from 'src/modules/customer/dto/create-favorite.dto';
import { UpdateFavoriteDto } from 'src/modules/customer/dto/update-favorite.dto';
import { EntityStatus, Customer, Favorite } from '@prisma/client';
import type { Request } from 'express';
import { QueryResponseDto } from 'src/common/dto/query-response.dto';

/** Plafond de `limit` sur « mes favoris » : l'application demande 10. */
export const FAVORIS_LIMITE_MAX = 50;

/**
 * Page et taille demandées, converties en nombres et bornées.
 *
 * Les paramètres d'URL arrivent en chaînes : la réponse renvoyait
 * `meta.page = "1"`, et l'application calculait la page suivante « 1 » + 1,
 * soit « 11 ». La deuxième page de favoris revenait donc toujours vide.
 */
export function paginationFavoris(page?: unknown, limit?: unknown): { page: number; limit: number } {
  const p = Math.floor(Number(page));
  const l = Math.floor(Number(limit));
  return {
    page: Number.isFinite(p) && p >= 1 ? p : 1,
    limit: Number.isFinite(l) && l >= 1 ? Math.min(l, FAVORIS_LIMITE_MAX) : 10,
  };
}

/**
 * Client joint à un favori sur les routes du personnel : de quoi le nommer,
 * jamais la fiche entière (téléphone, e-mail, date de naissance, points).
 */
const CLIENT_DU_FAVORI_SELECT = { id: true, first_name: true, last_name: true } as const;

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
      throw new NotFoundException('Plat introuvable');
    }

    // Vérifier si le favori existe déjà
    const existingFavorite = await this.prisma.favorite.findFirst({
      where: {
        customer_id: customer.id,
        dish_id: createFavoriteDto.dish_id,
      },
    });

    if (existingFavorite) {
      throw new ConflictException('Ce plat est déjà dans vos favoris');
    }

    return this.prisma.favorite.create({
      data: {
        dish_id: createFavoriteDto.dish_id,
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
        customer: { select: CLIENT_DU_FAVORI_SELECT },
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
        customer: { select: CLIENT_DU_FAVORI_SELECT },
        dish: {
          include: {
            category: true,
          },
        },
      },
    });

    if (!favorite) {
      throw new NotFoundException('Favori introuvable');
    }

    return favorite;
  }

  /**
   * Favori appartenant à CE client, sinon 404 : un client ne touche jamais
   * au favori d'un autre, même s'il en connaît l'identifiant.
   */
  private async favoriDuClient(customerId: string, id: string) {
    const favorite = await this.prisma.favorite.findFirst({
      where: { id, customer_id: customerId },
      select: { id: true },
    });
    if (!favorite) {
      throw new NotFoundException('Favori introuvable');
    }
    return favorite;
  }

  /**
   * « Mes favoris » : `customerId` vient TOUJOURS du jeton du client, jamais
   * de l'URL (voir le contrôleur).
   */
  async findByCustomer(customerId: string, pageDemandee?: unknown, limitDemandee?: unknown): Promise<QueryResponseDto<Favorite>> {
    const { page, limit } = paginationFavoris(pageDemandee, limitDemandee);

    // Exclure les favoris pointant vers un plat supprimé (entity_status DELETED) :
    // l'app cliente ne doit plus jamais voir un plat retiré du catalogue, même
    // s'il avait été mis en favori avant sa suppression.
    const where = {
      customer_id: customerId,
      dish: { entity_status: EntityStatus.ACTIVE },
    };

    const [favorites, count] = await Promise.all([
      this.prisma.favorite.findMany({
        where,
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
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.favorite.count({ where })
    ])

    return {
      data: favorites,
      meta: {
        total: count,
        page,
        limit,
        totalPages: Math.ceil(count / limit),
      },
    };
  }

  async update(customerId: string, id: string, updateFavoriteDto: UpdateFavoriteDto) {
    // Le favori doit appartenir au client connecté
    await this.favoriDuClient(customerId, id);

    // Vérifier si le plat existe (si fourni)
    if (updateFavoriteDto.dish_id) {
      const dish = await this.prisma.dish.findUnique({
        where: { id: updateFavoriteDto.dish_id },
      });

      if (!dish || dish.entity_status !== EntityStatus.ACTIVE) {
        throw new NotFoundException('Plat introuvable');
      }
    }

    // Seul le plat se change : jamais le client propriétaire du favori.
    return this.prisma.favorite.update({
      where: { id },
      data: { dish_id: updateFavoriteDto.dish_id },
      include: {
        dish: {
          include: {
            category: true,
          },
        },
      },
    });
  }

  async remove(customerId: string, id: string) {
    // Le favori doit appartenir au client connecté
    await this.favoriDuClient(customerId, id);

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
      throw new NotFoundException('Ce plat ne fait pas partie de vos favoris');
    }

    return this.prisma.favorite.delete({
      where: { id: favorite.id },
    });
  }
}