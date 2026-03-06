import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BaseStatsQueryDto } from './common-stats.dto';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { Transform } from 'class-transformer';

// ─── Query DTOs ────────────────────────────────────────────────────────────────

export class DeliveryStatsQueryDto extends BaseStatsQueryDto {
  @ApiPropertyOptional({ description: 'Nombre de zones à retourner', default: 10 })
  @IsInt()
  @Min(1)
  @Max(50)
  @IsOptional()
  @Transform(({ value }) => parseInt(value) || 10)
  limit?: number = 10;
}

// ─── Response DTOs ─────────────────────────────────────────────────────────────

export class DeliveryOverviewResponse {
  @ApiProperty({ description: 'Total livraisons sur la période' })
  totalDeliveries: number;

  @ApiProperty({ description: 'Frais de livraison collectés' })
  totalFeesCollected: number;

  @ApiProperty()
  totalFeesFormatted: string;

  @ApiProperty({ description: 'Frais moyen par livraison' })
  averageFee: number;

  @ApiProperty({ description: 'CA total des livraisons' })
  totalRevenue: number;

  @ApiProperty()
  totalRevenueFormatted: string;

  @ApiProperty({ description: 'Livraisons TURBO' })
  turboCount: number;

  @ApiProperty({ description: 'Livraisons FREE (internes)' })
  freeCount: number;

  @ApiProperty({ description: '% TURBO' })
  turboPercentage: number;

  @ApiProperty({ description: '% FREE' })
  freePercentage: number;

  @ApiProperty({ description: 'Évolution vs période précédente' })
  evolution: string;
}

export class DeliveryFeeBreakdownItem {
  @ApiProperty({ description: 'Label (Gratuit, 500 FCFA, ...)' })
  label: string;

  @ApiPropertyOptional({ description: 'Montant du frais (null = Autres)', nullable: true })
  feeAmount: number | null;

  @ApiProperty()
  orderCount: number;

  @ApiProperty()
  revenueGenerated: string;

  @ApiProperty()
  deliveryFeesCollected: number;

  @ApiProperty()
  percentage: number;
}

export class DeliveryFeesBreakdownResponse {
  @ApiProperty()
  totalDeliveryFees: number;

  @ApiProperty()
  totalDeliveryRevenue: number;

  @ApiProperty({ type: [DeliveryFeeBreakdownItem] })
  breakdown: DeliveryFeeBreakdownItem[];
}

export class DeliveryByZoneItem {
  @ApiProperty({ description: 'Ville / zone' })
  zone: string;

  @ApiProperty()
  orderCount: number;

  @ApiProperty()
  revenue: number;

  @ApiProperty()
  revenueFormatted: string;

  @ApiProperty()
  percentage: number;

  @ApiPropertyOptional({ description: 'Latitude centroid' })
  latitude?: number;

  @ApiPropertyOptional({ description: 'Longitude centroid' })
  longitude?: number;
}

export class DeliveryByZoneResponse {
  @ApiProperty({ type: [DeliveryByZoneItem] })
  items: DeliveryByZoneItem[];

  @ApiProperty()
  totalDeliveries: number;
}

export class DeliveryPerformanceResponse {
  @ApiProperty({ description: 'Temps moyen de livraison en minutes (ready → réception client)' })
  averageDeliveryMinutes: number;

  @ApiProperty({ description: 'Temps min' })
  minDeliveryMinutes: number;

  @ApiProperty({ description: 'Temps max' })
  maxDeliveryMinutes: number;

  @ApiProperty({ description: 'Taux de livraison à l\'heure en % (seuil 40 min)' })
  onTimeRate: number;

  @ApiProperty({ description: 'Commandes en retard' })
  lateOrders: number;

  @ApiProperty({ description: 'Commandes à l\'heure' })
  onTimeOrders: number;

  @ApiProperty({ description: 'Retard moyen en minutes (pour les commandes en retard)' })
  averageDelayMinutes: number;

  @ApiProperty({ description: 'Retard maximum en minutes' })
  maxDelayMinutes: number;
}
