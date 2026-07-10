import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/database/services/prisma.service';
import { RecordClickDto } from './dto/recordClick.dto';
import { RecordClickQueryDto } from './dto/recordClick-query.dto';
import { DeeplinkHelper } from './deeplink.helper';
import { RecordClickStatsDto } from './dto/recordClick-stats.dto';

@Injectable()
export class DeeplinkService {
  constructor(private prisma: PrismaService, private readonly DeeplinkHelper: DeeplinkHelper) { }

  /**
   * Enregistre un clic sur un lien de parrainage
   * @param data Les données du clic
   * @returns Le clic enregistré
   */
  async recordClick(data: RecordClickDto) {
    return this.prisma.appClick.create({ data });
  }

  /**
   * Récupère le nombre de clics correspondant aux critères de filtrage
   * @param query Les critères de filtrage
   * @returns Le nombre de clics correspondant aux critères
   */
  async getClicksCount(query: RecordClickQueryDto) {
    const where = this.DeeplinkHelper.buildClickWhereClause(query);

    return this.prisma.appClick.count({ where });
  }

  /**
   * Récupère les statistiques des clics
   * @returns Les statistiques des clics
   */
  async getClicksStats(query: RecordClickQueryDto = {}): Promise<RecordClickStatsDto> {
    // Les KPIs respectent EXACTEMENT les mêmes filtres que la liste
    // (période, type de deeplink, recherche…) → cohérence page entière.
    const where = this.DeeplinkHelper.buildClickWhereClause(query);

    const [total, android, ios, web, clicksByType] = await Promise.all([
      this.prisma.appClick.count({ where }),
      this.prisma.appClick.count({ where: { ...where, platform: 'android' } }),
      this.prisma.appClick.count({ where: { ...where, platform: 'ios' } }),
      this.prisma.appClick.count({ where: { ...where, platform: 'web' } }),
      this.prisma.appClick.groupBy({
        by: ['type'],
        where,
        _count: { _all: true },
      }),
    ]);

    // Répartition par type (lignes sans type = "unknown"), triée par count décroissant.
    const byType = clicksByType
      .map((g) => ({ type: g.type ?? 'unknown', count: g._count._all }))
      .sort((a, b) => b.count - a.count);

    return { total, android, ios, web, byType };
  }

  /**
   * Récupère les clics avec support pour la pagination, le filtrage et le tri.
   */
  async getFilteredClicks(query: RecordClickQueryDto) {
    const { page = 1, limit = 25 } = query;

    // Déterminer le décalage (skip)
    const skip = (page - 1) * limit;

    // Construire le filtre 'where'
    const where = this.DeeplinkHelper.buildClickWhereClause(query);

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