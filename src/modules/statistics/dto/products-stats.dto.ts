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
