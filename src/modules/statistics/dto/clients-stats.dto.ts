import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { Transform } from 'class-transformer';
import { BaseStatsQueryDto } from './common-stats.dto';

// ─── Query DTOs ────────────────────────────────────────────────────────────────

export class ClientsStatsQueryDto extends BaseStatsQueryDto {
  @ApiPropertyOptional({ description: 'Nombre de résultats', default: 10 })
  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  @Transform(({ value }) => parseInt(value) || 10)
  limit?: number = 10;
}

export class InactiveClientsQueryDto {
  @ApiPropertyOptional({
    description: 'Nombre de jours d\'inactivité minimum',
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

  @ApiPropertyOptional({ description: 'Nb max de résultats pour l\'export', default: 1000 })
  @IsInt()
  @Min(1)
  @Max(5000)
  @IsOptional()
  @Transform(({ value }) => parseInt(value) || 1000)
  limit?: number = 1000;
}

// ─── Response DTOs ─────────────────────────────────────────────────────────────

export class ClientsOverviewResponse {
  @ApiProperty({ description: 'Total clients avec au moins une commande' })
  totalClients: number;

  @ApiProperty({ description: 'Nouveaux clients sur la période' })
  newClients: number;

  @ApiProperty({ description: 'Clients récurrents sur la période' })
  recurringClients: number;

  @ApiProperty({ description: '% de nouveaux clients' })
  newClientsRate: number;

  @ApiProperty({ description: 'LTV moyen (total dépensé par client)' })
  averageLtv: number;

  @ApiProperty({ description: 'LTV moyen formaté' })
  averageLtvFormatted: string;

  @ApiProperty({ description: 'Panier moyen' })
  averageBasket: number;

  @ApiProperty({ description: 'Panier moyen formaté' })
  averageBasketFormatted: string;

  @ApiProperty({ description: 'Fréquence de commande moyenne (commandes / client)' })
  averageOrderFrequency: number;

  @ApiProperty({ description: 'Clients via App (auto=true)' })
  appClients: number;

  @ApiProperty({ description: 'Clients via Call Center (auto=false)' })
  callCenterClients: number;

  @ApiProperty({ description: 'Total tous clients inscrits (actifs)' })
  totalAllCustomers: number;

  @ApiProperty({ description: 'Clients sans app (pas de expo_push_token)' })
  noAppClients: number;

  @ApiProperty({ description: 'Clients ayant au moins 1 commande' })
  hasOrderedClients: number;

  @ApiProperty({ description: 'Clients inscrits mais 0 commandes' })
  neverOrderedClients: number;

  @ApiProperty({ description: 'Clients avec profil incomplet (nom/prénom/email manquant)' })
  incompleteProfileClients: number;
}

export class ClientAcquisitionDailyPoint {
  @ApiProperty({ description: 'Date (YYYY-MM-DD)' })
  date: string;

  @ApiProperty({ description: 'Label affiché' })
  label: string;

  @ApiProperty()
  newViaApp: number;

  @ApiProperty()
  newViaCallCenter: number;

  @ApiProperty()
  recurringViaApp: number;

  @ApiProperty()
  recurringViaCallCenter: number;
}

export class ClientsAcquisitionResponse {
  @ApiProperty({ description: 'Données journalières pour les Line Charts' })
  dailyTrend: ClientAcquisitionDailyPoint[];

  @ApiProperty({ description: 'Total nouveaux sur la période' })
  totalNew: number;

  @ApiProperty({ description: 'Total récurrents sur la période' })
  totalRecurring: number;

  @ApiProperty({ description: '% de rétention (récurrents / total)' })
  retentionRate: number;
}

export class ClientsRetentionResponse {
  @ApiProperty({ description: 'Clients actifs (au moins 1 commande dans les 30j)' })
  activeClients: number;

  @ApiProperty({ description: 'Clients inactifs depuis 30j (Churn 30j)' })
  churn30Days: number;

  @ApiProperty({ description: 'Taux de churn 30j en %' })
  churnRate30: number;

  @ApiProperty({ description: 'Clients inactifs depuis 60j (Churn 60j)' })
  churn60Days: number;

  @ApiProperty({ description: 'Taux de churn 60j en %' })
  churnRate60: number;

  @ApiProperty({ description: 'Clients à risque (inactifs 15-30j)' })
  atRiskClients: number;

  @ApiProperty({ description: 'Taux de rétention global en %' })
  retentionRate: number;
}

export class TopClientItem {
  @ApiProperty()
  id: string;

  @ApiProperty()
  fullname: string;

  @ApiProperty()
  phone: string;

  @ApiProperty()
  email: string;

  @ApiProperty()
  image: string;

  @ApiProperty({ description: 'Nombre total de commandes (tous temps)' })
  totalOrders: number;

  @ApiProperty({ description: 'Commandes sur la période sélectionnée' })
  ordersInPeriod: number;

  @ApiProperty({ description: 'CA total dépensé (LTV)' })
  totalSpent: number;

  @ApiProperty()
  totalSpentFormatted: string;

  @ApiProperty({ description: 'Panier moyen' })
  averageBasket: number;

  @ApiProperty({ description: 'Dernière commande' })
  lastOrderDate: string;

  @ApiProperty({ description: 'Canal préféré', enum: ['APP', 'CALL_CENTER', 'MIXED'] })
  preferredChannel: string;

  @ApiProperty({ description: 'Niveau fidélité', enum: ['STANDARD', 'PREMIUM', 'GOLD'] })
  loyaltyLevel: string;
}

export class TopClientsResponse {
  @ApiProperty({ type: [TopClientItem] })
  items: TopClientItem[];

  @ApiProperty()
  totalCount: number;
}

export class InactiveClientItem {
  @ApiProperty()
  id: string;

  @ApiProperty()
  fullname: string;

  @ApiProperty()
  phone: string;

  @ApiProperty()
  email: string;

  @ApiProperty({ description: 'Date de la dernière commande' })
  lastOrderDate: string;

  @ApiProperty({ description: 'Jours depuis la dernière commande' })
  daysSinceLastOrder: number;

  @ApiProperty()
  totalOrders: number;

  @ApiProperty()
  totalSpent: number;

  @ApiProperty()
  preferredChannel: string;
}

export class InactiveClientsResponse {
  @ApiProperty({ type: [InactiveClientItem] })
  items: InactiveClientItem[];

  @ApiProperty()
  totalCount: number;

  @ApiProperty({ description: 'Durée d\'inactivité utilisée' })
  inactiveDays: number;
}

export class ClientsByZoneItem {
  @ApiProperty({ description: 'Ville / quartier' })
  zone: string;

  @ApiProperty()
  clientCount: number;

  @ApiProperty()
  orderCount: number;

  @ApiProperty()
  percentage: number;
}

export class ClientsByZoneResponse {
  @ApiProperty({ type: [ClientsByZoneItem] })
  items: ClientsByZoneItem[];

  @ApiProperty()
  totalClients: number;
}

// ─── Nouveaux KPIs ──────────────────────────────────────────────────────────

export class LoyaltyLevelItem {
  @ApiProperty({ description: 'Niveau fidélité (STANDARD, PREMIUM, GOLD)' })
  level: string;

  @ApiProperty()
  clientCount: number;

  @ApiProperty()
  percentage: number;

  @ApiProperty({ description: 'CA moyen par client de ce niveau' })
  averageRevenue: number;
}

export class LoyaltyDistributionResponse {
  @ApiProperty({ type: [LoyaltyLevelItem] })
  items: LoyaltyLevelItem[];

  @ApiProperty()
  totalClients: number;
}

export class PaymentMethodItem {
  @ApiProperty({ description: 'ONLINE ou OFFLINE' })
  method: string;

  @ApiProperty()
  clientCount: number;

  @ApiProperty()
  orderCount: number;

  @ApiProperty()
  percentage: number;

  @ApiProperty()
  revenue: number;
}

export class PaymentMethodDistributionResponse {
  @ApiProperty({ type: [PaymentMethodItem] })
  items: PaymentMethodItem[];

  @ApiProperty()
  totalClients: number;
}

export class RevenueConcentrationResponse {
  @ApiProperty({ description: '% du CA généré par le top 10% des clients' })
  top10Percentage: number;

  @ApiProperty({ description: '% du CA généré par le top 20% des clients' })
  top20Percentage: number;

  @ApiProperty({ description: '% du CA généré par le top 50% des clients' })
  top50Percentage: number;

  @ApiProperty()
  totalRevenue: number;

  @ApiProperty()
  totalClients: number;
}

export class BasketComparisonResponse {
  @ApiProperty({ description: 'Panier moyen des nouveaux clients' })
  newClientsBasket: number;

  @ApiProperty({ description: 'Panier moyen des clients récurrents' })
  recurringClientsBasket: number;

  @ApiProperty({ description: 'CA total des nouveaux' })
  newClientsRevenue: number;

  @ApiProperty({ description: 'CA total des récurrents' })
  recurringClientsRevenue: number;

  @ApiProperty()
  newClientsOrders: number;

  @ApiProperty()
  recurringClientsOrders: number;
}

export class ClientAnalyticsProfileResponse {
  @ApiProperty()
  id: string;

  @ApiProperty()
  fullname: string;

  @ApiProperty()
  phone: string;

  @ApiProperty()
  image: string;

  @ApiProperty({ description: 'Canal préféré', enum: ['APP', 'CALL_CENTER', 'MIXED'] })
  preferredChannel: string;

  @ApiProperty({ description: 'Fréquence de commande (ex: 2.3 par mois)' })
  orderFrequencyPerMonth: number;

  @ApiProperty({ description: 'LTV total dépensé' })
  ltv: number;

  @ApiProperty()
  ltvFormatted: string;

  @ApiProperty({ description: 'Panier moyen' })
  averageBasket: number;

  @ApiProperty({ description: 'Total commandes' })
  totalOrders: number;

  @ApiProperty({ description: 'Date première commande' })
  firstOrderDate: string;

  @ApiProperty({ description: 'Date dernière commande' })
  lastOrderDate: string;

  @ApiProperty({ description: 'Top 5 plats préférés' })
  topDishes: { dishId: string; dishName: string; image: string; orderCount: number }[];

  @ApiProperty({ description: 'Niveau fidélité' })
  loyaltyLevel: string;

  @ApiProperty({ description: 'Points de fidélité actuels' })
  loyaltyPoints: number;
}
