import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { LoyaltyLevel, LoyaltyPointType, LoyaltyPointIsUsed, Customer } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { AddLoyaltyPointDto } from '../dto/add-loyalty-point.dto';
import { LoyaltyEvent } from '../events/loyalty.event';

@Injectable()
export class LoyaltyService {
    constructor(private prisma: PrismaService, private loyaltyEvent: LoyaltyEvent) { }

    async getConfig() {
        let config = await this.prisma.loyaltyConfig.findFirst({
            where: { is_active: true }
        });

        if (!config) {
            // Créer une configuration par défaut
            config = await this.prisma.loyaltyConfig.create({
                data: {
                    is_active: true
                }
            });
        }

        return config;
    }

    // Ajouter des points bonus ou gagnés
    async addPoints({ customer_id, points, type, reason, order_id }: AddLoyaltyPointDto) {
        const config = await this.getConfig();

        if (type !== LoyaltyPointType.EARNED && type !== LoyaltyPointType.BONUS) {
            throw new BadRequestException('Type de point requis');
        }

        const customer = await this.prisma.customer.findUnique({
            where: { id: customer_id }
        });

        if (!customer) {
            throw new NotFoundException('Client non trouvé');
        }

        return await this.prisma.$transaction(async (tx) => {
            // Ajouter les points
            const loyaltyPoint = await tx.loyaltyPoint.create({
                data: {
                    customer_id,
                    points,
                    type,
                    reason,
                    order_id,
                    expires_at: new Date(Date.now() + config.points_expiration_days! * 24 * 60 * 60 * 1000)
                }
            });

            // Mettre à jour les points du client

            await tx.customer.update({
                where: { id: customer_id },
                data: {
                    total_points: { increment: points },
                    lifetime_points: { increment: points }
                }
            });


            // Vérifier et mettre à jour le niveau de fidélité
            await this.updateCustomerLoyaltyLevel(customer, tx);

            // Evenement d'ajout de points
            this.loyaltyEvent.addPointsEvent({
                customer,
                points,
            });

            return loyaltyPoint;
        });
    }

    // Calculer les points pour une commande
    async calculatePointsForOrder(order_amount: number): Promise<number> {
        const config = await this.getConfig();

        if (!order_amount) {
            throw new BadRequestException('Montant de la commande requis');
        }

        return Math.floor(order_amount * config.points_per_xof);
    }

    // Calculer le montant pour une commande
    async calculateAmountForPoints(points: number): Promise<number> {
        const config = await this.getConfig();

        if (!points) {
            return 0;
        }

        return Math.floor(points * config.point_value_in_xof);
    }

    // Utiliser des points
    async redeemPoints({ customer_id, points, reason }: Omit<AddLoyaltyPointDto, 'type' | 'order_id'>) {
        const config = await this.getConfig();

        if (points < config.minimum_redemption_points) {
            throw new BadRequestException(`Minimum ${config.minimum_redemption_points} points requis pour utiliser`);
        }

        const customer = await this.prisma.customer.findUnique({
            where: { id: customer_id }
        });

        if (!customer || customer.total_points < points) {
            throw new BadRequestException('Points insuffisants');
        }

        const payload = await this.prisma.$transaction(async (tx) => {
            let remainingPointsToUse = points;
            const usedPointsDetails: any[] = [];

            // 1. Utiliser d'abord les points BONUS (par ordre de création/expiration)
            const bonusPoints = await tx.loyaltyPoint.findMany({
                where: {
                    customer_id,
                    type: LoyaltyPointType.BONUS,
                    is_used: { in: [LoyaltyPointIsUsed.NO, LoyaltyPointIsUsed.PARTIAL] },
                    OR: [
                        { expires_at: null },
                        { expires_at: { gt: new Date() } }
                    ]
                },
                orderBy: [
                    { expires_at: 'asc' }, // Les plus proches de l'expiration d'abord
                    { created_at: 'asc' }
                ]
            });

            for (const bonusPoint of bonusPoints) {
                if (remainingPointsToUse <= 0) break;

                const availablePoints = bonusPoint.points - (bonusPoint.points_used || 0);
                const pointsToUse = Math.min(remainingPointsToUse, availablePoints);

                if (pointsToUse > 0) {
                    const newPointsUsed = (bonusPoint.points_used || 0) + pointsToUse;
                    const newIsUsed = newPointsUsed >= bonusPoint.points ? LoyaltyPointIsUsed.YES : LoyaltyPointIsUsed.PARTIAL;

                    await tx.loyaltyPoint.update({
                        where: { id: bonusPoint.id },
                        data: {
                            points_used: newPointsUsed,
                            is_used: newIsUsed
                        }
                    });

                    usedPointsDetails.push({
                        point_id: bonusPoint.id,
                        type: LoyaltyPointType.BONUS,
                        points_used: pointsToUse,
                        points_remaining: bonusPoint.points - newPointsUsed
                    });

                    remainingPointsToUse -= pointsToUse;
                }
            }

            // 2. Si les bonus ne suffisent pas, utiliser les points EARNED
            if (remainingPointsToUse > 0) {
                const earnedPoints = await tx.loyaltyPoint.findMany({
                    where: {
                        customer_id,
                        type: LoyaltyPointType.EARNED,
                        is_used: { in: [LoyaltyPointIsUsed.NO, LoyaltyPointIsUsed.PARTIAL] },
                        OR: [
                            { expires_at: null },
                            { expires_at: { gt: new Date() } }
                        ]
                    },
                    orderBy: [
                        { expires_at: 'asc' }, // Les plus proches de l'expiration d'abord
                        { created_at: 'asc' }
                    ]
                });

                for (const earnedPoint of earnedPoints) {
                    if (remainingPointsToUse <= 0) break;

                    const availablePoints = earnedPoint.points - (earnedPoint.points_used || 0);
                    const pointsToUse = Math.min(remainingPointsToUse, availablePoints);

                    if (pointsToUse > 0) {
                        const newPointsUsed = (earnedPoint.points_used || 0) + pointsToUse;
                        const newIsUsed = newPointsUsed >= earnedPoint.points ? LoyaltyPointIsUsed.YES : LoyaltyPointIsUsed.PARTIAL;

                        await tx.loyaltyPoint.update({
                            where: { id: earnedPoint.id },
                            data: {
                                points_used: newPointsUsed,
                                is_used: newIsUsed
                            }
                        });

                        usedPointsDetails.push({
                            point_id: earnedPoint.id,
                            type: LoyaltyPointType.EARNED,
                            points_used: pointsToUse,
                            points_remaining: earnedPoint.points - newPointsUsed
                        });

                        remainingPointsToUse -= pointsToUse;
                    }
                }
            }

            // Vérification finale
            if (remainingPointsToUse > 0) {
                throw new BadRequestException('Points insuffisants disponibles');
            }

            // Créer l'enregistrement de rachat
            const redemptionRecord = await tx.loyaltyPoint.create({
                data: {
                    customer_id,
                    points,
                    type: LoyaltyPointType.REDEEMED,
                    reason,
                    points_used: points,
                    is_used: LoyaltyPointIsUsed.YES
                }
            });

            // Mettre à jour les points du client
            await tx.customer.update({
                where: { id: customer_id },
                data: {
                    total_points: { decrement: points }
                }
            });

            // Vérifier et mettre à jour le niveau de fidélité
            await this.updateCustomerLoyaltyLevel(customer, tx);

            return {
                redemption_record: redemptionRecord,
                used_points_details: usedPointsDetails,
                total_points_used: points,
            };
        });

        // Evenement de rachat de points
        this.loyaltyEvent.redeemPointsEvent({
            customer,
            points,
        });

        return payload;
    }

    // Obtenir les informations de fidélité d'un client
    async getCustomerLoyaltyInfo(customer_id: string) {
        const customer = await this.prisma.customer.findUnique({
            where: { id: customer_id },
            include: {
                loyalty_points: {
                    orderBy: { created_at: 'desc' },
                    take: 10
                },
                loyalty_level_history: {
                    orderBy: { created_at: 'desc' },
                    take: 5
                }
            }
        });

        if (!customer) {
            throw new NotFoundException('Client non trouvé');
        }

        const config = await this.getConfig();

        // Calculer le prochain niveau et les points nécessaires
        let nextLevel: LoyaltyLevel | null = null;
        let pointsToNextLevel = 0;

        switch (customer.loyalty_level) {
            case LoyaltyLevel.STANDARD:
                nextLevel = LoyaltyLevel.PREMIUM;
                pointsToNextLevel = config.premium_threshold - customer.lifetime_points;
                break;
            case LoyaltyLevel.PREMIUM:
                nextLevel = LoyaltyLevel.GOLD;
                pointsToNextLevel = config.gold_threshold - customer.lifetime_points;
                break;
            case LoyaltyLevel.GOLD:
                nextLevel = null;
                pointsToNextLevel = 0;
                break;
        }

        // Calculer les points disponibles par type
        const availablePointsByType = await this.prisma.loyaltyPoint.groupBy({
            by: ['type'],
            where: {
                customer_id,
                is_used: { in: [LoyaltyPointIsUsed.NO, LoyaltyPointIsUsed.PARTIAL] },
                OR: [
                    { expires_at: null },
                    { expires_at: { gt: new Date() } }
                ]
            },
            _sum: {
                points: true,
                points_used: true
            }
        });

        const pointsBreakdown = availablePointsByType.map(group => ({
            type: group.type,
            total_points: group._sum.points || 0,
            used_points: group._sum.points_used || 0,
            available_points: (group._sum.points || 0) - (group._sum.points_used || 0)
        }));

        return {
            customer_id: customer.id,
            current_level: customer.loyalty_level,
            total_points: customer.total_points,
            lifetime_points: customer.lifetime_points,
            next_level: nextLevel,
            points_to_next_level: Math.max(0, pointsToNextLevel),
            points_breakdown: pointsBreakdown,
            recent_points: customer.loyalty_points,
            level_history: customer.loyalty_level_history,
            points_value_in_xof: customer.total_points * config.point_value_in_xof
        };
    }

    // Mettre à jour le niveau de fidélité d'un client
    private async updateCustomerLoyaltyLevel(customer: Customer, tx: any) {
        const config = await this.getConfig();

        let newLevel: LoyaltyLevel | null = null;

        if (customer.lifetime_points >= config.gold_threshold) {
            newLevel = LoyaltyLevel.GOLD;
        } else if (customer.lifetime_points >= config.premium_threshold) {
            newLevel = LoyaltyLevel.PREMIUM;
        } else if (customer.lifetime_points >= config.standard_threshold) {
            newLevel = LoyaltyLevel.STANDARD;
        }

        if (newLevel && newLevel !== customer.loyalty_level) {
            // Mettre à jour le niveau du client
            await tx.customer.update({
                where: { id: customer.id },
                data: {
                    loyalty_level: newLevel,
                    last_level_update: new Date()
                }
            });

            // Enregistrer l'historique
            await tx.loyaltyLevelHistory.create({
                data: {
                    customer_id: customer.id,
                    previous_level: customer.loyalty_level,
                    new_level: newLevel,
                    points_at_time: customer.lifetime_points,
                    reason: 'Mise à jour automatique basée sur les points accumulés'
                }
            });
            // Attribuer des points bonus pour le nouveau niveau
            let bonusPoints = 0;
            switch (newLevel) {
                case LoyaltyLevel.STANDARD:
                    bonusPoints = 100;
                    break;
                case LoyaltyLevel.PREMIUM:
                    bonusPoints = 150;
                    break;
                case LoyaltyLevel.GOLD:
                    bonusPoints = 200;
                    break;
            }

            // Evenement de niveau atteint
            this.loyaltyEvent.levelUpEvent({
                customer,
                new_level: newLevel,
                bonus_points: bonusPoints
            });
        }
    }

    // Expirer les points
    async expirePoints() {
        const now = new Date();

        // Récupérer tous les points qui ne sont pas totalement utilisés et qui sont expirés
        const expiredPoints = await this.prisma.loyaltyPoint.findMany({
            where: {
                type: {
                    in: [LoyaltyPointType.EARNED, LoyaltyPointType.BONUS]
                },
                expires_at: { lt: now },
                is_used: { in: [LoyaltyPointIsUsed.NO, LoyaltyPointIsUsed.PARTIAL] } // Seulement les points non totalement utilisés
            },
            include: {
                customer: true
            }
        });

        let totalExpiredPoints = 0;

        for (const point of expiredPoints) {
            await this.prisma.$transaction(async (tx) => {
                const remainingPoints = point.points - (point.points_used || 0);

                if (remainingPoints > 0) {
                    // Marquer le point comme expiré
                    await tx.loyaltyPoint.update({
                        where: { id: point.id },
                        data: {
                            type: LoyaltyPointType.EXPIRED,
                            is_used: LoyaltyPointIsUsed.YES // Marquer comme totalement "utilisé" (expiré)
                        }
                    });

                    // Décrémenter les points restants du client
                    await tx.customer.update({
                        where: { id: point.customer_id },
                        data: {
                            total_points: { decrement: remainingPoints }
                        }
                    });

                    totalExpiredPoints += remainingPoints;
                }
            });
        }

        return {
            expired_point_records: expiredPoints.length,
            total_points_expired: totalExpiredPoints
        };
    }

    // Obtenir le détail des points utilisables d'un client
    async getAvailablePointsBreakdown(customer_id: string) {
        const availablePoints = await this.prisma.loyaltyPoint.findMany({
            where: {
                customer_id,
                is_used: { in: [LoyaltyPointIsUsed.NO, LoyaltyPointIsUsed.PARTIAL] },
                type: { in: [LoyaltyPointType.EARNED, LoyaltyPointType.BONUS] },
                OR: [
                    { expires_at: null },
                    { expires_at: { gt: new Date() } }
                ]
            },
            orderBy: [
                { type: 'desc' }, // BONUS avant EARNED
                { expires_at: 'asc' }, // Les plus proches de l'expiration d'abord
                { created_at: 'asc' }
            ]
        });

        return availablePoints.map(point => ({
            id: point.id,
            type: point.type,
            total_points: point.points,
            used_points: point.points_used || 0,
            available_points: point.points - (point.points_used || 0),
            expires_at: point.expires_at,
            created_at: point.created_at,
            reason: point.reason
        }));
    }
}