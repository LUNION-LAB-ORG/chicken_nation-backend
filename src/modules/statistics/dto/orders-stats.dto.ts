import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsIn, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { Transform } from 'class-transformer';
import { OrderStatus, OrderType } from '@prisma/client';
import { BaseStatsQueryDto } from './common-stats.dto';

// ─── Query DTOs ────────────────────────────────────────────────────────────────

export class OrdersStatsQueryDto extends BaseStatsQueryDto {
  @ApiPropertyOptional({ enum: OrderType })
  @IsEnum(OrderType)
  @IsOptional()
  type?: OrderType;

  @ApiPropertyOptional({ enum: OrderStatus })
  @IsEnum(OrderStatus)
  @IsOptional()
  status?: OrderStatus;

  @ApiPropertyOptional({
    enum: ['APP', 'CALL_CENTER'],
    description: 'Canal : APP (auto=true) ou CALL_CENTER (auto=false)',
  })
  @IsIn(['APP', 'CALL_CENTER'])
  @IsOptional()
  channel?: 'APP' | 'CALL_CENTER';

  @ApiPropertyOptional({ description: 'Granularité pour les tendances', enum: ['day', 'week', 'month'], default: 'day' })
  @IsIn(['day', 'week', 'month'])
  @IsOptional()
  @Transform(({ value }) => value || 'day')
  granularity?: 'day' | 'week' | 'month';
}

// ─── Response DTOs ─────────────────────────────────────────────────────────────

export class OrderByStatusItem {
  @ApiProperty()
  status: string;

  @ApiProperty()
  label: string;

  @ApiProperty()
  count: number;

  @ApiProperty()
  percentage: number;
}

export class OrderByTypeItem {
  @ApiProperty()
  type: string;

  @ApiProperty()
  label: string;

  @ApiProperty()
  count: number;

  @ApiProperty()
  revenue: number;

  @ApiProperty()
  percentage: number;
}

export class OrdersOverviewResponse {
  @ApiProperty()
  totalOrders: number;

  @ApiProperty()
  totalRevenue: number;

  @ApiProperty({ description: 'CA formaté (1 500 000 XOF)' })
  totalRevenueFormatted: string;

  @ApiProperty({ description: 'Panier moyen' })
  averageBasket: number;

  @ApiProperty()
  cancelledOrders: number;

  @ApiProperty({ description: 'Taux d\'annulation en %' })
  cancellationRate: number;

  @ApiProperty({ description: 'Évolution vs période précédente' })
  evolution: string;

  @ApiProperty({ type: [OrderByStatusItem] })
  byStatus: OrderByStatusItem[];

  @ApiProperty({ type: [OrderByTypeItem] })
  byType: OrderByTypeItem[];
}

export class DailyTrendPoint {
  @ApiProperty({ description: 'Date (YYYY-MM-DD)' })
  date: string;

  @ApiProperty({ description: 'Label affiché (lun., 12 jan.)' })
  label: string;

  @ApiProperty({ description: 'Nouveaux clients via App' })
  newViaApp: number;

  @ApiProperty({ description: 'Nouveaux clients via Call Center' })
  newViaCallCenter: number;

  @ApiProperty({ description: 'Clients récurrents via App' })
  recurringViaApp: number;

  @ApiProperty({ description: 'Clients récurrents via Call Center' })
  recurringViaCallCenter: number;

  @ApiProperty({ description: 'Total commandes du jour' })
  total: number;
}

export class ChannelStats {
  @ApiProperty()
  totalOrders: number;

  @ApiProperty()
  revenue: number;

  @ApiProperty()
  averageBasket: number;

  @ApiProperty({ description: 'Commandes de nouveaux clients' })
  newClientsOrders: number;

  @ApiProperty({ description: 'Commandes de clients récurrents' })
  recurringClientsOrders: number;

  @ApiProperty({ description: '% de nouveaux clients' })
  newClientsRate: number;
}

export class OrdersByChannelResponse {
  @ApiProperty({ type: ChannelStats, description: 'Canal App mobile (auto=true)' })
  app: ChannelStats;

  @ApiProperty({ type: ChannelStats, description: 'Canal Call Center (auto=false)' })
  callCenter: ChannelStats;

  @ApiProperty({ type: [DailyTrendPoint], description: 'Tendance journalière avec courbes' })
  dailyTrend: DailyTrendPoint[];
}

export class ProcessingStepStats {
  @ApiProperty({ description: 'Nom de l\'étape' })
  step: string;

  @ApiProperty({ description: 'Description' })
  description: string;

  @ApiProperty({ description: 'Temps moyen en minutes' })
  averageMinutes: number;

  @ApiProperty({ description: 'Temps min en minutes' })
  minMinutes: number;

  @ApiProperty({ description: 'Temps max en minutes' })
  maxMinutes: number;
}

export class ProcessingTimeResponse {
  @ApiProperty({ description: 'Temps total moyen (commande → livraison) en minutes' })
  averageMinutes: number;

  @ApiProperty({ description: 'Temps total min en minutes' })
  minMinutes: number;

  @ApiProperty({ description: 'Temps total max en minutes' })
  maxMinutes: number;

  @ApiProperty({ description: 'Nombre de commandes analysées' })
  sampleSize: number;

  @ApiProperty({ type: [ProcessingStepStats], description: 'Détail par étape' })
  byStep: ProcessingStepStats[];
}

export class LateOrdersResponse {
  @ApiProperty({ description: 'Total commandes livraison avec estimated_delivery_time' })
  totalDeliveryOrders: number;

  @ApiProperty({ description: 'Commandes à l\'heure' })
  onTimeOrders: number;

  @ApiProperty({ description: 'Commandes en retard' })
  lateOrders: number;

  @ApiProperty({ description: 'Taux de retard en %' })
  lateRate: number;

  @ApiProperty({ description: 'Retard moyen en minutes' })
  averageDelayMinutes: number;

  @ApiProperty({ description: 'Retard max en minutes' })
  maxDelayMinutes: number;
}

export class OrdersByRestaurantItem {
  @ApiProperty()
  restaurantId: string;

  @ApiProperty()
  restaurantName: string;

  @ApiProperty()
  restaurantImage: string;

  @ApiProperty()
  totalOrders: number;

  @ApiProperty()
  revenue: number;

  @ApiProperty()
  revenueFormatted: string;

  @ApiProperty()
  averageBasket: number;

  @ApiProperty()
  percentage: number;

  @ApiProperty({ description: 'Évolution vs période précédente' })
  evolution: string;
}

export class OrdersByRestaurantResponse {
  @ApiProperty({ type: [OrdersByRestaurantItem] })
  items: OrdersByRestaurantItem[];

  @ApiProperty()
  totalOrders: number;

  @ApiProperty()
  totalRevenue: number;
}

// ─── Ponctualité restaurant (accepted_at → ready_at) ──────────────────────────

export class RestaurantPunctualityItem {
  @ApiProperty()
  restaurantId: string;

  @ApiProperty()
  restaurantName: string;

  @ApiProperty()
  totalOrders: number;

  @ApiProperty({ description: 'Temps moyen de préparation en minutes' })
  averagePrepMinutes: number;

  @ApiProperty()
  minPrepMinutes: number;

  @ApiProperty()
  maxPrepMinutes: number;
}

export class RestaurantPunctualityResponse {
  @ApiProperty()
  totalOrders: number;

  @ApiProperty()
  averagePrepMinutes: number;

  @ApiProperty()
  minPrepMinutes: number;

  @ApiProperty()
  maxPrepMinutes: number;

  @ApiProperty({ type: [RestaurantPunctualityItem] })
  byRestaurant: RestaurantPunctualityItem[];
}

// ─── Par Restaurant et Type (histogrammes empilés) ─────────────────────────────

export class RestaurantTypeItem {
  @ApiProperty()
  restaurantId: string;

  @ApiProperty()
  restaurantName: string;

  @ApiProperty({ description: 'Commandes livraison' })
  delivery: number;

  @ApiProperty({ description: 'Commandes retrait' })
  pickup: number;

  @ApiProperty({ description: 'Commandes sur place' })
  table: number;

  @ApiProperty()
  total: number;
}

export class OrdersByRestaurantAndTypeResponse {
  @ApiProperty({ type: [RestaurantTypeItem] })
  items: RestaurantTypeItem[];
}

// ─── Par Restaurant et Source (App / Call Center) ──────────────────────────────

export class RestaurantSourceItem {
  @ApiProperty()
  restaurantId: string;

  @ApiProperty()
  restaurantName: string;

  @ApiProperty({ description: 'Commandes via App (auto=true)' })
  app: number;

  @ApiProperty({ description: 'Commandes via Call Center (auto=false)' })
  callCenter: number;

  @ApiProperty()
  total: number;
}

export class OrdersByRestaurantAndSourceResponse {
  @ApiProperty({ type: [RestaurantSourceItem] })
  items: RestaurantSourceItem[];
}

// ─── Zones Clients (heat map) ──────────────────────────────────────────────────

export class ClientZonePoint {
  @ApiProperty()
  lat: number;

  @ApiProperty()
  lng: number;

  @ApiProperty({ description: 'Nombre de commandes dans cette zone' })
  count: number;
}

export class ClientZonesResponse {
  @ApiProperty({ type: [ClientZonePoint] })
  points: ClientZonePoint[];

  @ApiProperty()
  totalOrders: number;

  @ApiProperty({ description: 'Nombre de zones distinctes' })
  totalPoints: number;

  @ApiProperty({ description: 'Centre moyen pour le centrage de la carte' })
  center: { lat: number; lng: number };
}

export class DailyOrdersTrendPoint {
  @ApiProperty()
  date: string;

  @ApiProperty()
  label: string;

  @ApiProperty()
  count: number;

  @ApiProperty()
  revenue: number;

  @ApiProperty()
  averageBasket: number;
}

export class OrdersDailyTrendResponse {
  @ApiProperty({ type: [DailyOrdersTrendPoint] })
  data: DailyOrdersTrendPoint[];

  @ApiProperty()
  totalOrders: number;

  @ApiProperty()
  totalRevenue: number;
}

// ─── Tendance par Restaurant (histogramme empilé) ──────────────────────────────

export class RestaurantMetrics {
  @ApiProperty()
  count: number;

  @ApiProperty()
  revenue: number;

  @ApiProperty()
  avgBasket: number;

  @ApiProperty({ description: 'Taux de ponctualité en %' })
  onTimeRate: number;
}

export class DailyTrendByRestaurantPoint {
  @ApiProperty()
  date: string;

  @ApiProperty()
  label: string;

  @ApiProperty({ description: 'Métriques par restaurant { [restaurantId]: metrics }' })
  byRestaurant: Record<string, RestaurantMetrics>;

  @ApiProperty()
  total: RestaurantMetrics;
}

export class RestaurantInfo {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;
}

export class DailyTrendByRestaurantResponse {
  @ApiProperty({ type: [RestaurantInfo] })
  restaurants: RestaurantInfo[];

  @ApiProperty({ type: [DailyTrendByRestaurantPoint] })
  data: DailyTrendByRestaurantPoint[];
}

// ─── Restaurants Locations ──────────────────────────────────────────────────────

export class RestaurantLocationItem {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  latitude: number;

  @ApiProperty()
  longitude: number;

  @ApiProperty()
  image: string;

  @ApiProperty()
  address: string;
}

export class RestaurantsLocationsResponse {
  @ApiProperty({ type: [RestaurantLocationItem] })
  restaurants: RestaurantLocationItem[];
}

// ─── Zones d'influence restaurants ──────────────────────────────────────────────

export class InfluenceZonePoint {
  @ApiProperty()
  lat: number;

  @ApiProperty()
  lng: number;

  @ApiProperty()
  restaurantId: string;

  @ApiProperty()
  count: number;
}

export class InfluenceZonesResponse {
  @ApiProperty({ type: [RestaurantInfo] })
  restaurants: RestaurantInfo[];

  @ApiProperty({ type: [InfluenceZonePoint] })
  points: InfluenceZonePoint[];

  @ApiProperty()
  totalOrders: number;

  @ApiProperty()
  center: { lat: number; lng: number };
}
