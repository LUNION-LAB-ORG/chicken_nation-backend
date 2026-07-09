import { ApiProperty } from '@nestjs/swagger';

export class PlatformClicksStats {
  @ApiProperty({
    description: 'Nombre total de clics depuis le début',
    example: 1500,
  })
  allTime: number;

  @ApiProperty({
    description: 'Nombre de clics du mois en cours',
    example: 250,
  })
  currentMonth: number;
}

export class TotalClicksStats {
  @ApiProperty({
    description: 'Nombre total de clics depuis le début',
    example: 3000,
  })
  allTime: number;

  @ApiProperty({
    description: 'Nombre de clics du mois en cours',
    example: 500,
  })
  currentMonth: number;

  @ApiProperty({
    description: 'Nombre de clics dans les dernières 24 heures',
    example: 75,
  })
  last24Hours: number;
}

export class TypeClicksStats {
  @ApiProperty({
    description: 'Type de cible du deeplink (ou "unknown" si non renseigné)',
    example: 'dish',
  })
  type: string;

  @ApiProperty({
    description: 'Nombre de clics pour ce type de cible',
    example: 120,
  })
  count: number;
}

export class RecordClickStatsDto {
  @ApiProperty({
    description: 'Statistiques globales des clics',
    type: TotalClicksStats,
  })
  total: TotalClicksStats;

  @ApiProperty({
    description: 'Statistiques des clics Android',
    type: PlatformClicksStats,
  })
  android: PlatformClicksStats;

  @ApiProperty({
    description: 'Statistiques des clics iOS',
    type: PlatformClicksStats,
  })
  ios: PlatformClicksStats;

  @ApiProperty({
    description: 'Répartition des clics par type de cible (triée par nombre décroissant)',
    type: [TypeClicksStats],
  })
  byType: TypeClicksStats[];
}