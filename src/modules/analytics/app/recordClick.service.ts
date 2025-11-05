import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/database/services/prisma.service';
import { RecordClickDto } from './dto/recordClick.dto';
import { RecordClickQueryDto } from './dto/recordClick-query.dto';
import { RecordClickHelper } from './recordClick.helper';

@Injectable()
export class RecordClickService {
  constructor(private prisma: PrismaService, private readonly recordClickHelper: RecordClickHelper) { }

  // --- Méthodes existantes ---

  async recordClick(data: RecordClickDto) {
    return this.prisma.appClick.create({ data });
  }

  async getClicksCount(query: RecordClickQueryDto) {
    const where = this.recordClickHelper.buildClickWhereClause(query);
    return this.prisma.appClick.count({ where });
  }

  /**
   * Récupère les clics avec support pour la pagination, le filtrage et le tri.
   */
  async getFilteredClicks(query: RecordClickQueryDto) {
    const { page = 1, limit = 25 } = query;

    // Déterminer le décalage (skip)
    const skip = (page - 1) * limit;

    // Construire le filtre 'where'
    const where = this.recordClickHelper.buildClickWhereClause(query);

    // 1. Compter le total des éléments correspondant au filtre (pour la pagination)
    const totalCount = await this.prisma.appClick.count({ where });

    // 2. Récupérer les données paginées et filtrées
    const data = await this.prisma.appClick.findMany({
      where,
      skip: skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
    });

    // Retourner les données avec les métadonnées de pagination
    return {
      data,
      totalCount,
      page,
      limit,
      totalPages: Math.ceil(totalCount / limit),
    };
  }
}