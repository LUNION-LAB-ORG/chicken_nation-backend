import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/database/services/prisma.service';
import { RecordClickDto } from './dto/recordClick.dto';
import { RecordClickQueryDto } from './dto/recordClick-query.dto';
import { AppMobileHelper } from './app-mobile.helper';
import { RecordClickStatsDto } from './dto/recordClick-stats.dto';

@Injectable()
export class AppMobileService {
  constructor(private prisma: PrismaService, private readonly AppMobileHelper: AppMobileHelper) { }

  // --- Méthodes existantes ---

  async recordClick(data: RecordClickDto) {
    return this.prisma.appClick.create({ data });
  }

  async getClicksCount(query: RecordClickQueryDto) {
    const where = this.AppMobileHelper.buildClickWhereClause(query);

    return this.prisma.appClick.count({ where });
  }

  /**
   * Récupère les statistiques des clics
   */
  async getClicksStats(): Promise<RecordClickStatsDto> {
    const now = new Date();

    // Date de début du mois en cours (1er jour à 00:00:00)
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    // Date il y a 24h
    const last24Hours = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    // Récupérer toutes les statistiques en parallèle pour optimiser les performances
    const [
      totalClicks,
      monthClicks,
      last24HoursClicks,
      totalAndroidClicks,
      monthAndroidClicks,
      totalIosClicks,
      monthIosClicks,
    ] = await Promise.all([
      // Nombre total de clics
      this.prisma.appClick.count(),

      // Nombre de clics du mois en cours
      this.prisma.appClick.count({
        where: {
          createdAt: {
            gte: startOfMonth,
          },
        },
      }),

      // Nombre de clics dans les dernières 24h
      this.prisma.appClick.count({
        where: {
          createdAt: {
            gte: last24Hours,
          },
        },
      }),

      // Nombre total de clics Android
      this.prisma.appClick.count({
        where: {
          platform: 'android',
        },
      }),

      // Nombre de clics Android du mois en cours
      this.prisma.appClick.count({
        where: {
          platform: 'android',
          createdAt: {
            gte: startOfMonth,
          },
        },
      }),

      // Nombre total de clics iOS
      this.prisma.appClick.count({
        where: {
          platform: 'ios',
        },
      }),

      // Nombre de clics iOS du mois en cours
      this.prisma.appClick.count({
        where: {
          platform: 'ios',
          createdAt: {
            gte: startOfMonth,
          },
        },
      }),
    ]);

    return {
      total: {
        allTime: totalClicks,
        currentMonth: monthClicks,
        last24Hours: last24HoursClicks,
      },
      android: {
        allTime: totalAndroidClicks,
        currentMonth: monthAndroidClicks,
      },
      ios: {
        allTime: totalIosClicks,
        currentMonth: monthIosClicks,
      },
    };
  }
  /**
   * Récupère les clics avec support pour la pagination, le filtrage et le tri.
   */
  async getFilteredClicks(query: RecordClickQueryDto) {
    const { page = 1, limit = 25 } = query;

    // Déterminer le décalage (skip)
    const skip = (page - 1) * limit;

    // Construire le filtre 'where'
    const where = this.AppMobileHelper.buildClickWhereClause(query);

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