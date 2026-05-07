import { Injectable, Logger } from '@nestjs/common';
import { EntityStatus, OrderStatus, Prisma } from '@prisma/client';

import { PrismaService } from 'src/database/services/prisma.service';

import { QueryDelivererHistoryDto } from '../dto/query-deliverer-history.dto';

/**
 * Service dédié aux opérations livreur sur les commandes.
 * Séparé de OrderService pour :
 *  - Éviter de polluer le service principal (déjà ~1000 lignes)
 *  - Scoper strictement les requêtes au livreur connecté (sécurité)
 */
@Injectable()
export class OrderDelivererService {
  private readonly logger = new Logger(OrderDelivererService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Récupère l'historique des courses d'un livreur (paginé, filtré).
   *
   * Par défaut on retourne COMPLETED + CANCELLED (historique terminé).
   * Si `status` est fourni, on filtre sur celui-ci uniquement.
   *
   * Tri par `created_at` DESC (plus récent en premier).
   */
  async getHistory(delivererId: string, filters: QueryDelivererHistoryDto) {
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 20;
    const skip = (page - 1) * limit;

    // Depuis la migration course_and_delivery, le lien Order ↔ Deliverer
    // passe par Delivery → Course. On filtre via la relation.
    const where: Prisma.OrderWhereInput = {
      delivery: {
        course: {
          deliverer_id: delivererId,
        },
      },
      entity_status: { not: EntityStatus.DELETED },
      ...(filters.status
        ? { status: filters.status }
        : { status: { in: [OrderStatus.COMPLETED, OrderStatus.CANCELLED] } }),
      ...(filters.startDate || filters.endDate
        ? {
            created_at: {
              ...(filters.startDate && { gte: new Date(filters.startDate) }),
              ...(filters.endDate && { lte: new Date(filters.endDate) }),
            },
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        skip,
        take: limit,
        orderBy: { created_at: 'desc' },
        select: {
          id: true,
          reference: true,
          status: true,
          amount: true,
          net_amount: true,
          delivery_fee: true,
          address: true,
          type: true,
          fullname: true,
          phone: true,
          note: true,
          created_at: true,
          updated_at: true,
          customer: {
            select: {
              id: true,
              first_name: true,
              last_name: true,
              phone: true,
            },
          },
          restaurant: { select: { id: true, name: true, address: true } },
        },
      }),
      this.prisma.order.count({ where }),
    ]);

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }
}
