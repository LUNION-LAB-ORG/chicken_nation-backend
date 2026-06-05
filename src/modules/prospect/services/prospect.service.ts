import { BadRequestException, Injectable } from '@nestjs/common';
import { EntityStatus, Prisma, ProspectStatus, User, UserType } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { CreateProspectDto } from '../dto/create-prospect.dto';
import { QueryProspectDto } from '../dto/query-prospect.dto';

@Injectable()
export class ProspectService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Un agent "store" (caissier/manager rattaché à un restaurant) est cloisonné :
   * il ne saisit/consulte que les contacts de SON restaurant. L'admin/central
   * (restaurant_id null) voit tout.
   */
  private isStoreUser(user: User): boolean {
    return user.type === UserType.RESTAURANT && !!user.restaurant_id;
  }

  /** Saisie d'un contact. Le store est forcé au restaurant de l'agent store. */
  async create(user: User, dto: CreateProspectDto) {
    const restaurantId = this.isStoreUser(user)
      ? user.restaurant_id!
      : dto.restaurant_id;

    if (!restaurantId) {
      throw new BadRequestException(
        'Le store (restaurant) est obligatoire pour enregistrer un contact.',
      );
    }

    return this.prisma.prospect.create({
      data: {
        platform: dto.platform,
        name: dto.name,
        order_number: dto.order_number,
        phone: dto.phone,
        status: ProspectStatus.NOUVEAU,
        restaurant: { connect: { id: restaurantId } },
        ...(user.id && { creator: { connect: { id: user.id } } }),
      },
      include: { restaurant: { select: { id: true, name: true } } },
    });
  }

  /**
   * Détection de doublon par téléphone AVANT saisie (cf. cahier §4.3 :
   * « alerte doublon possible »). Cloisonné au store pour un agent store.
   */
  async checkPhone(user: User, phone: string) {
    const cleaned = (phone || '').replace(/\D/g, '');
    if (cleaned.length !== 10) {
      return { exists: false, prospect: null };
    }

    const where: Prisma.ProspectWhereInput = {
      phone: cleaned,
      entity_status: { not: EntityStatus.DELETED },
    };
    if (this.isStoreUser(user)) {
      where.restaurant_id = user.restaurant_id!;
    }

    const existing = await this.prisma.prospect.findFirst({
      where,
      orderBy: { created_at: 'desc' },
      include: { restaurant: { select: { id: true, name: true } } },
    });

    return {
      exists: !!existing,
      prospect: existing
        ? {
            id: existing.id,
            name: existing.name,
            status: existing.status,
            restaurant: existing.restaurant,
            created_at: existing.created_at,
          }
        : null,
    };
  }

  /**
   * Liste des contacts (admin), triée du plus ancien au plus récent (cahier §4.2).
   * Filtrage store/plateforme/statut/période + recherche.
   */
  async findAll(user: User, query: QueryProspectDto) {
    const {
      restaurantId,
      platform,
      status,
      search,
      startDate,
      endDate,
      page = 1,
      limit = 20,
    } = query;

    const where: Prisma.ProspectWhereInput = {
      entity_status: { not: EntityStatus.DELETED },
      ...(platform && { platform }),
      ...(status && { status }),
    };

    // Cloisonnement : agent store -> son restaurant ; admin -> filtre optionnel
    if (this.isStoreUser(user)) {
      where.restaurant_id = user.restaurant_id!;
    } else if (restaurantId) {
      where.restaurant_id = restaurantId;
    }

    if (search) {
      const s = search.trim();
      where.OR = [
        { name: { contains: s, mode: 'insensitive' } },
        { phone: { contains: s.replace(/\D/g, '') } },
        { order_number: { contains: s } },
      ];
    }

    if (startDate || endDate) {
      where.created_at = {
        ...(startDate && { gte: new Date(startDate) }),
        ...(endDate && {
          lte: new Date(new Date(endDate).setHours(23, 59, 59, 999)),
        }),
      };
    }

    const [data, total] = await Promise.all([
      this.prisma.prospect.findMany({
        where,
        include: {
          restaurant: { select: { id: true, name: true } },
          creator: { select: { id: true, fullname: true } },
        },
        orderBy: { created_at: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.prospect.count({ where }),
    ]);

    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }
}
