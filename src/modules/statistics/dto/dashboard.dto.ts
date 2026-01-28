import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsIn, IsDateString, ValidateIf } from 'class-validator';
import { Transform, Type } from 'class-transformer';

export class GetStatsQueryDto {
    @ApiPropertyOptional({
        description: 'ID du restaurant pour filtrer les statistiques',
        example: 'uuid-restaurant-id'
    })
    @IsString()
    @IsOptional()
    restaurantId?: string;

    @ApiPropertyOptional({
        description: 'Date de début (ISO format)',
        example: '2024-01-01'
    })
    @IsDateString()
    @IsOptional()
    @ValidateIf((o) => o.startDate || o.endDate)
    startDate?: string;

    @ApiPropertyOptional({
        description: 'Date de fin (ISO format)',
        example: '2024-01-31'
    })
    @IsDateString()
    @IsOptional()
    @ValidateIf((o) => o.startDate || o.endDate)
    endDate?: string;

    @ApiPropertyOptional({
        enum: ['today', 'week', 'month', 'year'],
        description: 'Période prédéfinie pour les statistiques',
        default: 'month'
    })
    @IsIn(['today', 'week', 'month', 'year'])
    @IsOptional()
    @Transform(({ value }) => value || 'month')
    period?: 'today' | 'week' | 'month' | 'year';
}

export class ObjectiveData {
    @ApiProperty({ description: 'Valeur de l\'objectif' })
    value: string;

    @ApiProperty({ description: 'Pourcentage d\'atteinte de l\'objectif' })
    @Type(() => Number)
    percentage: number;
}

export class StatCardData {
    @ApiProperty({ description: 'Titre de la statistique' })
    title: string;

    @ApiProperty({ description: 'Valeur principale' })
    value: string;

    @ApiPropertyOptional({ description: 'Unité de mesure' })
    unit?: string;

    @ApiProperty({ description: 'Texte du badge de tendance' })
    badgeText: string;

    @ApiProperty({ description: 'Couleur du badge (green, red, blue, etc.)' })
    badgeColor: string;

    @ApiProperty({ description: 'Chemin vers l\'icône' })
    iconImage: string;

    @ApiPropertyOptional({ type: ObjectiveData })
    objective?: ObjectiveData;
}

export class TrendData {
    @ApiProperty({ description: 'Pourcentage de variation' })
    percentage: string;

    @ApiProperty({ description: 'Période de comparaison' })
    comparedTo: string;

    @ApiProperty({ description: 'Indique si la tendance est positive' })
    isPositive: boolean;
}

export class HourlyValue {
    @ApiProperty({ description: 'Heure (format HH:mm)' })
    hour: string;

    @ApiProperty({ description: 'Valeur pour cette heure' })
    value: number;
}

export class PeriodicData {
    @ApiProperty({ description: 'Nom de la période (jour, mois)' })
    name: string;

    @ApiProperty({ description: 'Valeur pour cette période' })
    value: number;
}

export class DailyRevenueData {
    @ApiProperty({ description: 'Total des revenus' })
    total: string;

    @ApiProperty({ type: TrendData })
    trend: TrendData;

    @ApiPropertyOptional({
        type: [HourlyValue],
        description: 'Données par heure (uniquement pour la période "today")'
    })
    hourlyValues?: HourlyValue[];
}

export class RevenueData {
    @ApiProperty({ type: DailyRevenueData })
    dailyData: DailyRevenueData;

    @ApiPropertyOptional({
        type: [PeriodicData],
        description: 'Données mensuelles (uniquement pour la période "year")'
    })
    monthlyData?: PeriodicData[];
}

export class DailyOrder {
    @ApiProperty({ description: 'Jour de la semaine (abrégé)' })
    day: string;

    @ApiProperty({ description: 'Nombre de commandes' })
    @Type(() => Number)
    count: number;
}

export class WeeklyOrdersData {
    @ApiProperty({
        type: [String],
        description: 'Plages de dates des 4 dernières semaines'
    })
    dateRanges: string[];

    @ApiProperty({ description: 'Plage de dates actuelle' })
    currentRange: string;

    @ApiProperty({ type: [DailyOrder] })
    dailyOrders: DailyOrder[];
}

export class BestSellingMenuItem {
    @ApiProperty({ description: 'ID du plat' })
    id: string;

    @ApiProperty({ description: 'Nom du plat' })
    name: string;

    @ApiProperty({ description: 'Quantité vendue' })
    @Type(() => Number)
    count: number;

    @ApiProperty({ description: 'URL de l\'image du plat' })
    image: string;

    @ApiProperty({ description: 'Pourcentage des ventes totales' })
    @Type(() => Number)
    percentage: number;

    @ApiProperty({ description: 'Texte descriptif du pourcentage' })
    interestedPercentage: string;
}

export class SalesCategory {
    @ApiProperty({ description: 'Nom du mode de paiement' })
    label: string;

    @ApiProperty({ description: 'Montant formaté avec unité' })
    value: string;

    @ApiProperty({ description: 'Couleur hexadécimale' })
    color: string;

    @ApiProperty({ description: 'Pourcentage du total' })
    @Type(() => Number)
    percentage: number;
}

export class DailySalesData {
    @ApiProperty({ description: 'Titre de la section' })
    title: string;

    @ApiProperty({ description: 'Sous-titre avec total' })
    subtitle: string;

    @ApiProperty({ type: [SalesCategory] })
    categories: SalesCategory[];
}

export class StatsCards {
    @ApiProperty({ type: StatCardData })
    revenue: StatCardData;

    @ApiProperty({ type: StatCardData })
    menusSold: StatCardData;

    @ApiProperty({ type: StatCardData })
    totalOrders: StatCardData;

    @ApiProperty({ type: StatCardData })
    totalCustomers: StatCardData;
}
// 1. Ajoutez la classe pour le détail d'une ligne (ex: "Livraison 500F")
export class DeliveryFeeBreakdown {
    @ApiProperty({ description: 'Libellé (ex: "Gratuit", "500 FCFA", "Autres")' })
    label: string;

    @ApiPropertyOptional({ description: 'Montant du frais (null si catégorie "Autres")', type: Number, nullable: true })
    feeAmount: number | null;

    @ApiProperty({ description: 'Nombre de commandes concernées' })
    @Type(() => Number)
    orderCount: number;

    @ApiProperty({ description: 'Chiffre d\'affaires généré par ces commandes (formaté)' })
    revenueGenerated: string;

    @ApiProperty({ description: 'Total des frais de livraison collectés pour ce groupe' })
    @Type(() => Number)
    deliveryFeesCollected: number;

    @ApiProperty({ description: 'Pourcentage par rapport au nombre total de commandes' })
    @Type(() => Number)
    percentage: number;
}

// 2. Ajoutez la classe conteneur pour les stats de livraison
export class DeliveryStatsData {
    @ApiProperty({ description: 'Somme totale des frais de livraison collectés sur la période' })
    @Type(() => Number)
    totalDeliveryFees: number;

    @ApiProperty({ description: 'Chiffre d\'affaires total des commandes livrées' })
    @Type(() => Number)
    totalDeliveryRevenue: number;

    @ApiProperty({ type: [DeliveryFeeBreakdown], description: 'Détail par montant de frais' })
    breakdown: DeliveryFeeBreakdown[];
}

export class DashboardViewModel {
    @ApiProperty({ type: StatsCards })
    stats: StatsCards;

    @ApiProperty({ type: RevenueData })
    revenue: RevenueData;

    @ApiProperty({ type: WeeklyOrdersData })
    weeklyOrders: WeeklyOrdersData;

    @ApiProperty({ type: [BestSellingMenuItem] })
    bestSellingMenus: BestSellingMenuItem[];

    @ApiProperty({ type: DailySalesData })
    dailySales: DailySalesData;

    @ApiProperty({ type: DeliveryStatsData, description: 'Statistiques détaillées sur la livraison' })
    deliveryStats: DeliveryStatsData;
}

// DTOs pour les endpoints spécialisés
export class RevenueStatsResponse {
    @ApiProperty({ type: RevenueData })
    revenue: RevenueData;

    @ApiProperty({ type: StatCardData })
    revenueCard: StatCardData;
}

export class OrdersStatsResponse {
    @ApiProperty({ type: WeeklyOrdersData })
    weeklyOrders: WeeklyOrdersData;

    @ApiProperty({ type: StatCardData })
    ordersCard: StatCardData;
}

export class MenusStatsResponse {
    @ApiProperty({ type: [BestSellingMenuItem] })
    bestSellingMenus: BestSellingMenuItem[];

    @ApiProperty({ type: StatCardData })
    menusSoldCard: StatCardData;
}

export class CustomersStatsResponse {
    @ApiProperty({ type: StatCardData })
    customersCard: StatCardData;
}