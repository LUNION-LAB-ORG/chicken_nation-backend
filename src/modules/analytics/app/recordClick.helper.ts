import { Prisma } from '@prisma/client';
import { RecordClickQueryDto } from './dto/recordClick-query.dto';
import { Injectable } from '@nestjs/common';

@Injectable()
export class RecordClickHelper {

  /**
   * Construit l'objet 'where' pour la requête Prisma en fonction des paramètres du DTO.
   */
  buildClickWhereClause(query: RecordClickQueryDto): Prisma.AppClickWhereInput {
    const where: Prisma.AppClickWhereInput = {};

    // 1. Recherche globale (si 'search' est présent)
    if (query.search) {
      const searchTerms = { contains: query.search, mode: 'insensitive' as Prisma.QueryMode };
      where.OR = [
        { platform: searchTerms },
        { userAgent: searchTerms },
        { ip: searchTerms },
      ];
    }

    // 2. Filtrage spécifique (si les champs sont présents)
    if (query.platform) {
      where.platform = { contains: query.platform, mode: 'insensitive' as Prisma.QueryMode };
    }
    if (query.ip) {
      // Pour une recherche exacte de l'IP, utilisez simplement where.ip = query.ip;
      // Pour une recherche partielle (ex: par sous-réseau), utilisez 'contains' :
      where.ip = { contains: query.ip };
    }

    // 3. Filtrage temporel (Plage de Dates)
    if (query.dateFrom || query.dateTo) {
      where.createdAt = {
        ...(query.dateFrom && { gte: new Date(query.dateFrom) }), // greater than or equal
        ...(query.dateTo && { lte: new Date(query.dateTo) }),    // less than or equal
      };
    }

    return where;
  }

}