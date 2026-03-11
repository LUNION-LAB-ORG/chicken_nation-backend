import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { BaseStatsQueryDto } from './common-stats.dto';

// ─── Query DTOs ────────────────────────────────────────────────────────────────

export class ProductsStatsQueryDto extends BaseStatsQueryDto {
  @ApiPropertyOptional({
    description: 'Filtrer par catégorie',
    example: 'uuid-category-id',
  })
  @IsUUID()
  @IsOptional()
  categoryId?: string;

  @ApiPropertyOptional({
    description: 'Nombre de résultats à retourner',
    default: 10,
    minimum: 1,
    maximum: 50,
  })
  @IsInt()
  @Min(1)
  @Max(50)
  @IsOptional()
  @Transform(({ value }) => parseInt(value) || 10)
  limit?: number = 10;
}

export class ProductsComparisonQueryDto {
  @ApiPropertyOptional({ description: 'Restaurant ID' })
  @IsUUID()
  @IsOptional()
  restaurantId?: string;

  @ApiPropertyOptional({ description: 'Catégorie ID' })
  @IsUUID()
  @IsOptional()
  categoryId?: string;

  @ApiPropertyOptional({ description: 'Début période 1', example: '2025-01-01' })
  period1Start: string;

  @ApiPropertyOptional({ description: 'Fin période 1', example: '2025-01-31' })
  period1End: string;

  @ApiPropertyOptional({ description: 'Début période 2', example: '2025-02-01' })
  period2Start: string;

  @ApiPropertyOptional({ description: 'Fin période 2', example: '2025-02-28' })
  period2End: string;

  @ApiPropertyOptional({ default: 10 })
  @IsInt()
  @Min(1)
  @Max(50)
  @IsOptional()
  @Transform(({ value }) => parseInt(value) || 10)
  limit?: number = 10;
}

// ─── Response DTOs ─────────────────────────────────────────────────────────────

// Répartition des ventes par source (App, Call Center, HubRise)
export class SourceBreakdown {
  @ApiProperty({ description: 'Quantité vendue via l\'App' })
  app: number;

  @ApiProperty({ description: 'Quantité vendue via Call Center' })
  callCenter: number;

  @ApiProperty({ description: 'Quantité vendue via HubRise' })
  hubrise: number;
}

export class TopProductItem {
  @ApiProperty({ description: 'ID du plat' })
  id: string;

  @ApiProperty({ description: 'Nom du plat' })
  name: string;

  @ApiProperty({ description: 'URL image' })
  image: string;

  @ApiProperty({ description: 'Catégorie' })
  categoryName: string;

  @ApiProperty({ description: 'Quantité totale vendue' })
  totalSold: number;

  @ApiProperty({ description: 'CA généré (net_amount)' })
  revenue: number;

  @ApiProperty({ description: '% des ventes totales' })
  percentage: number;

  @ApiPropertyOptional({ description: 'Évolution vs période précédente (+15.0%)' })
  evolution?: string;

  @ApiPropertyOptional({ description: 'Quantité vendue période précédente' })
  previousPeriodSold?: number;

  @ApiProperty({ description: 'Répartition par source (App / Call Center / HubRise)', type: SourceBreakdown })
  sourceBreakdown: SourceBreakdown;
}

export class TopProductsResponse {
  @ApiProperty({ type: [TopProductItem] })
  items: TopProductItem[];

  @ApiProperty({ description: 'Total plats vendus sur la période' })
  totalSold: number;

  @ApiProperty({ description: 'Nombre de plats distincts vendus' })
  uniqueDishesCount: number;
}

export class TopCategoryItem {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  image: string;

  @ApiProperty({ description: 'Quantité vendue' })
  totalSold: number;

  @ApiProperty({ description: 'CA généré' })
  revenue: number;

  @ApiProperty({ description: '% du total' })
  percentage: number;

  @ApiProperty({ description: 'Nombre de plats distincts dans la catégorie' })
  dishCount: number;
}

export class TopCategoriesResponse {
  @ApiProperty({ type: [TopCategoryItem] })
  items: TopCategoryItem[];

  @ApiProperty()
  totalSold: number;
}

export class ProductComparisonItem {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  image: string;

  @ApiProperty()
  categoryName: string;

  @ApiProperty({ description: 'Ventes période 1' })
  period1Sold: number;

  @ApiProperty({ description: 'Ventes période 2' })
  period2Sold: number;

  @ApiProperty({ description: 'Évolution (+15.0%)' })
  evolution: string;

  @ApiProperty({ description: 'Valeur d\'évolution en nombre' })
  evolutionValue: number;
}

export class ProductComparisonResponse {
  @ApiProperty({ type: [ProductComparisonItem] })
  items: ProductComparisonItem[];

  @ApiProperty({ description: 'Label période 1 (ex: Jan 2025)' })
  period1Label: string;

  @ApiProperty({ description: 'Label période 2 (ex: Fév 2025)' })
  period2Label: string;
}

export class ProductByRestaurantItem {
  @ApiProperty()
  restaurantId: string;

  @ApiProperty()
  restaurantName: string;

  @ApiProperty()
  totalSold: number;

  @ApiProperty()
  revenue: number;

  @ApiProperty()
  percentage: number;
}

export class ProductsByRestaurantResponse {
  @ApiProperty()
  dishId: string;

  @ApiProperty()
  dishName: string;

  @ApiProperty({ type: [ProductByRestaurantItem] })
  byRestaurant: ProductByRestaurantItem[];
}

export class ProductByZoneItem {
  @ApiProperty({ description: 'Ville / quartier' })
  zone: string;

  @ApiProperty()
  orderCount: number;

  @ApiProperty()
  percentage: number;
}

export class TopProductByZoneItem {
  @ApiProperty()
  dishId: string;

  @ApiProperty()
  dishName: string;

  @ApiProperty()
  image: string;

  @ApiProperty()
  totalSold: number;

  @ApiProperty({ type: [ProductByZoneItem], description: 'Répartition par zone' })
  zones: ProductByZoneItem[];
}

export class ProductsByZoneResponse {
  @ApiProperty({ type: [TopProductByZoneItem] })
  items: TopProductByZoneItem[];
}

// ─── Nouveaux KPIs ──────────────────────────────────────────────────────────

export class SalesTrendDailyPoint {
  @ApiProperty({ description: 'Date (YYYY-MM-DD)' })
  date: string;

  @ApiProperty({ description: 'Label affiché (ex: "Lun 03")' })
  label: string;

  @ApiProperty({ description: 'Quantité totale vendue ce jour' })
  totalQuantity: number;

  @ApiProperty({ description: 'CA généré ce jour' })
  totalRevenue: number;
}

export class SalesTrendResponse {
  @ApiProperty({ type: [SalesTrendDailyPoint] })
  dailyData: SalesTrendDailyPoint[];

  @ApiProperty({ description: 'Quantité totale sur la période' })
  totalQuantity: number;

  @ApiProperty({ description: 'CA total sur la période' })
  totalRevenue: number;
}

export class ChannelBreakdownResponse {
  @ApiProperty({ description: 'Plats vendus via App' })
  appSold: number;

  @ApiProperty({ description: 'CA via App' })
  appRevenue: number;

  @ApiProperty({ description: 'Plats vendus via Call Center' })
  callCenterSold: number;

  @ApiProperty({ description: 'CA via Call Center' })
  callCenterRevenue: number;

  @ApiProperty({ description: '% App' })
  appPercentage: number;

  @ApiProperty({ description: '% Call Center' })
  callCenterPercentage: number;

  @ApiProperty({ description: 'Total plats vendus' })
  totalSold: number;
}

export class PromotionPerformanceResponse {
  @ApiProperty({ description: 'Nombre de plats en promo vendus' })
  promoDishCount: number;

  @ApiProperty({ description: 'Quantité totale vendue (promo)' })
  promoTotalSold: number;

  @ApiProperty({ description: 'CA total (promo)' })
  promoRevenue: number;

  @ApiProperty({ description: 'Panier moyen par plat promo' })
  promoAvgBasket: number;

  @ApiProperty({ description: 'Nombre de plats réguliers vendus' })
  regularDishCount: number;

  @ApiProperty({ description: 'Quantité totale vendue (régulier)' })
  regularTotalSold: number;

  @ApiProperty({ description: 'CA total (régulier)' })
  regularRevenue: number;

  @ApiProperty({ description: 'Panier moyen par plat régulier' })
  regularAvgBasket: number;

  @ApiProperty({ description: '% du CA provenant des promos' })
  promoRevenueShare: number;
}
