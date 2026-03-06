import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import { Transform } from 'class-transformer';
import { BaseStatsQueryDto } from './common-stats.dto';

// ─── Query DTOs ────────────────────────────────────────────────────────────────

export class PromoUsageQueryDto extends BaseStatsQueryDto {
  @ApiPropertyOptional({ description: 'Filtrer par code promo spécifique' })
  @IsString()
  @IsOptional()
  promoCode?: string;

  @ApiPropertyOptional({ description: 'Filtrer par ID promotion' })
  @IsUUID()
  @IsOptional()
  promotionId?: string;
}

export class ChurnExportQueryDto {
  @ApiPropertyOptional({
    description: 'Inactivité en jours (30 ou 60)',
    default: 30,
  })
  @IsInt()
  @Min(1)
  @IsOptional()
  @Transform(({ value }) => parseInt(value) || 30)
  inactiveDays?: number = 30;

  @ApiPropertyOptional()
  @IsUUID()
  @IsOptional()
  restaurantId?: string;
}

export class TopZonesQueryDto extends BaseStatsQueryDto {
  @ApiPropertyOptional({ description: 'Nombre de zones', default: 5 })
  @IsInt()
  @Min(1)
  @Max(20)
  @IsOptional()
  @Transform(({ value }) => parseInt(value) || 5)
  limit?: number = 5;
}

// ─── Response DTOs ─────────────────────────────────────────────────────────────

export class PromoUsageItem {
  @ApiProperty()
  id: string;

  @ApiProperty({ description: 'Titre de la promotion' })
  title: string;

  @ApiPropertyOptional({ description: 'Code promo (si applicable)' })
  code?: string;

  @ApiProperty({ description: 'Type de réduction', enum: ['PERCENTAGE', 'FIXED_AMOUNT', 'BUY_X_GET_Y'] })
  discountType: string;

  @ApiProperty({ description: 'Valeur de la réduction' })
  discountValue: number;

  @ApiProperty({ description: 'Nombre d\'utilisations' })
  usageCount: number;

  @ApiProperty({ description: 'Total des réductions accordées' })
  totalDiscount: number;

  @ApiProperty()
  totalDiscountFormatted: string;

  @ApiProperty({ description: 'CA généré par les commandes avec cette promo' })
  revenueGenerated: number;

  @ApiProperty()
  revenueGeneratedFormatted: string;

  @ApiProperty({ description: 'Clients uniques ayant utilisé cette promo' })
  uniqueUsers: number;
}

export class PromoUsageResponse {
  @ApiProperty({ type: [PromoUsageItem] })
  items: PromoUsageItem[];

  @ApiProperty()
  totalPromos: number;

  @ApiProperty()
  totalDiscountAccorded: number;

  @ApiProperty()
  totalRevenueWithPromo: number;
}

export class TopZoneItem {
  @ApiProperty({ description: 'Ville / quartier' })
  zone: string;

  @ApiProperty()
  orderCount: number;

  @ApiProperty()
  revenue: number;

  @ApiProperty()
  revenueFormatted: string;

  @ApiProperty()
  percentage: number;

  @ApiPropertyOptional({ description: 'Latitude centroïde de la zone' })
  latitude?: number;

  @ApiPropertyOptional({ description: 'Longitude centroïde de la zone' })
  longitude?: number;
}

export class TopZonesResponse {
  @ApiProperty({ type: [TopZoneItem] })
  items: TopZoneItem[];

  @ApiProperty()
  totalOrders: number;
}

export class ChurnExportItem {
  @ApiProperty()
  phone: string;

  @ApiProperty()
  firstName: string;

  @ApiProperty()
  lastName: string;

  @ApiProperty()
  email: string;

  @ApiProperty({ description: 'Date dernière commande' })
  lastOrderDate: string;

  @ApiProperty()
  daysSinceLastOrder: number;

  @ApiProperty()
  totalOrders: number;

  @ApiProperty({ description: 'CA total dépensé' })
  totalSpent: number;

  @ApiProperty({ description: 'Canal préféré' })
  preferredChannel: string;
}

export class ChurnExportResponse {
  @ApiProperty({ type: [ChurnExportItem] })
  items: ChurnExportItem[];

  @ApiProperty()
  totalCount: number;

  @ApiProperty()
  inactiveDays: number;
}

export class PromotionPerformanceItem {
  @ApiProperty()
  id: string;

  @ApiProperty()
  title: string;

  @ApiProperty()
  status: string;

  @ApiProperty()
  usageCount: number;

  @ApiProperty()
  maxUsage: number;

  @ApiProperty({ description: 'Taux d\'utilisation en %' })
  usageRate: number;

  @ApiProperty()
  revenueGenerated: number;

  @ApiProperty()
  revenueGeneratedFormatted: string;

  @ApiProperty()
  startDate: string;

  @ApiProperty()
  expirationDate: string;
}

export class PromotionsPerformanceResponse {
  @ApiProperty({ type: [PromotionPerformanceItem] })
  items: PromotionPerformanceItem[];

  @ApiProperty()
  totalActivePromos: number;

  @ApiProperty()
  totalRevenueWithPromo: number;
}
