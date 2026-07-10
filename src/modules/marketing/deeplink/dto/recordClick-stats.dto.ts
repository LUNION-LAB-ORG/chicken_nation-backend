import { ApiProperty } from '@nestjs/swagger';

export class TypeClicksStats {
  @ApiProperty({ description: 'Type de deeplink', example: 'dish' })
  type: string;

  @ApiProperty({ description: 'Nombre de clics pour ce type', example: 42 })
  count: number;
}

/**
 * Statistiques des clics — TOUTES filtrées par la même requête que la liste
 * (période, type, recherche…) pour que les KPIs suivent les filtres de la page.
 */
export class RecordClickStatsDto {
  @ApiProperty({ description: 'Nombre total de clics (filtré)', example: 1500 })
  total: number;

  @ApiProperty({ description: 'Clics Android (filtré)', example: 600 })
  android: number;

  @ApiProperty({ description: 'Clics iOS (filtré)', example: 700 })
  ios: number;

  @ApiProperty({ description: 'Clics Web / desktop (filtré)', example: 200 })
  web: number;

  @ApiProperty({
    description: 'Répartition des clics par type de deeplink',
    type: [TypeClicksStats],
  })
  byType: TypeClicksStats[];
}
