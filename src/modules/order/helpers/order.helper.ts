import { Injectable, BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import { CreateOrderDto } from 'src/modules/order/dto/create-order.dto';
import { UpdateOrderDto } from 'src/modules/order/dto/update-order.dto';
import { OrderStatus, OrderType, PaiementStatus, EntityStatus, Customer, Dish, Address, SupplementCategory } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/database/services/prisma.service';
import { Request } from 'express';
import { QueryOrderDto } from '../dto/query-order.dto';
import { GenerateDataService } from 'src/common/services/generate-data.service';
// import { NotificationService } from '../notification/notification.service';
// import { LoyaltyService } from '../loyalty/loyalty.service';
// import { DeliveryService } from '../delivery/delivery.service';
// import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class OrderHelper {
    private readonly taxRate: number;
    private readonly baseDeliveryFee: number;

    constructor(
        private prisma: PrismaService,
        private configService: ConfigService,
        private generateDataService: GenerateDataService,
        // private notificationService: NotificationService,
        // private loyaltyService: LoyaltyService,
        // private deliveryService: DeliveryService,
    ) {
        this.taxRate = this.configService.get<number>('ORDER_TAX_RATE', 0.005);
        this.baseDeliveryFee = this.configService.get<number>('BASE_DELIVERY_FEE', 1000);
    }

    async resolveCustomerData(orderData: CreateOrderDto) {
        // Si un customer_id est fourni, utiliser ce client
        if (orderData.customer_id) {
            const customer = await this.prisma.customer.findFirst({
                where: {
                    id: orderData.customer_id,
                    OR: [{ phone: orderData.phone }],
                },
            });

            if (!customer) {
                throw new BadRequestException('Client introuvable');
            }

            return {
                customer_id: customer.id,
                fullname: orderData.fullname || `${customer.first_name} ${customer.last_name}`,
                phone: orderData.phone || customer.phone,
                email: orderData.email || customer.email,
            };
        }
        throw new BadRequestException('Aucun client sélectionné');
    }

    async getClosestRestaurant(orderData: CreateOrderDto) {
        // 1. Récupération de l'adresse
        const address = await this.validateAddress(orderData.address_id);

        // 2. Récupération des restaurants actifs
        const restaurants = await this.prisma.restaurant.findMany({
            where: {
                entity_status: EntityStatus.ACTIVE,
            },
            select: {
                id: true,
                name: true,
                latitude: true,
                longitude: true,
            },
        });

        if (!restaurants.length) {
            throw new BadRequestException('Aucun restaurant disponible');
        }

        // 3. Calcul de la distance et sélection du plus proche
        const closest = restaurants.reduce((prev, curr) => {
            const prevDistance = this.generateDataService.haversineDistance(
                address.latitude,
                address.longitude,
                prev.latitude ?? 0,
                prev.longitude ?? 0,
            );
            const currDistance = this.generateDataService.haversineDistance(
                address.latitude,
                address.longitude,
                curr.latitude ?? 0,
                curr.longitude ?? 0,
            );
            return currDistance < prevDistance ? curr : prev;
        });

        return closest;
    }

    async getDishesWithDetails(dishIds: string[]) {
        const dishes = await this.prisma.dish.findMany({
            where: {
                id: { in: dishIds },
                entity_status: EntityStatus.ACTIVE
            },
            include: {
                dish_supplements: {
                    include: {
                        supplement: true,
                    },
                },
            },
        });

        if (dishes.length !== dishIds.length) {
            throw new BadRequestException('Un ou plusieurs plats sont introuvables ou indisponibles');
        }

        return dishes;
    }

    async validateAddress(addressId: string) {
        const address = await this.prisma.address.findFirst({
            where: { id: addressId, entity_status: EntityStatus.ACTIVE },
        });

        if (!address) {
            throw new BadRequestException('Adresse de livraison invalide ou introuvable');
        }
        return address;
    }

    async applyPromoCode(promoCode?: string): Promise<number> {
        if (!promoCode) return 0;

        // Logique pour vérifier et appliquer un code promo
        // Idéalement, nous aurions une table pour les codes promo

        // Pour simplifier, on renvoie 0 (pas de réduction)
        return 0;
    }

    async calculateOrderDetails(items: CreateOrderDto['items'], dishes: Dish[]) {
        let netAmount = 0;
        const orderItems: { dish_id: string; quantity: number; amount: number; supplements: { id: string; name: string; price: number; category: SupplementCategory }[]; }[] = [];

        for (const item of items) {
            const dish = dishes.find(d => d.id === item.dish_id);

            if (!dish) {
                throw new BadRequestException('Un ou plusieurs plats sont introuvables ou indisponibles');
            }

            // Récupérer et valider les suppléments
            let supplementsTotal = 0;
            let supplementsData: { id: string; name: string; price: number; category: SupplementCategory }[] = [];

            if (item.supplements_ids && item.supplements_ids.length > 0) {
                let supplement_items = item.supplements_ids;
                if(typeof item.supplements_ids === 'string') {
                    supplement_items = [item.supplements_ids];
                }
                const supplements = await this.prisma.supplement.findMany({
                    where: {
                        id: { in: supplement_items },
                        available: true,
                        dish_supplements: {
                            some: {
                                dish_id: dish.id
                            }
                        }
                    },
                });

                if (supplements.length !== item.supplements_ids.length) {
                    throw new BadRequestException('Un ou plusieurs suppléments sont invalides pour ce plat');
                }

                supplementsData = supplements.map(s => ({
                    id: s.id,
                    name: s.name,
                    price: s.price,
                    category: s.category,
                }));

                supplementsTotal = supplements.reduce((sum, s) => sum + s.price, 0);
            }

            // Calculer le prix du plat
            const itemPrice = (dish.is_promotion && dish.promotion_price !== null)
                ? dish.promotion_price
                : dish.price;

            const itemAmount = itemPrice + supplementsTotal;
            const lineTotal = itemAmount * item.quantity;

            netAmount += lineTotal;

            orderItems.push({
                dish_id: item.dish_id,
                quantity: item.quantity,
                amount: itemAmount,
                supplements: supplementsData,
            });
        }

        return { orderItems, netAmount };
    }

    async calculateTax(netAmount: number): Promise<number> {
        try {
            // Dans un système réel, on calculerait la distance et appliquerait un tarif
            // Pour simplifier, on utilise un tarif fixe
            return this.taxRate * netAmount;
        } catch (error) {
            // En cas d'erreur, utiliser le tarif de base
            return 0;
        }
    }
    async calculateDeliveryFee(orderType: OrderType, address: Address): Promise<number> {
        if (orderType !== OrderType.DELIVERY) {
            return 0; // Pas de frais de livraison pour les commandes sur place ou à emporter
        }

        try {
            // Dans un système réel, on calculerait la distance et appliquerait un tarif
            // Pour simplifier, on utilise un tarif fixe
            return this.baseDeliveryFee;
        } catch (error) {
            // En cas d'erreur, utiliser le tarif de base
            return this.baseDeliveryFee;
        }
    }

    calculateEstimatedDeliveryTime(orderType: OrderType): Date {
        const now = new Date();
        let additionalMinutes = 0;

        switch (orderType) {
            case OrderType.DELIVERY:
                additionalMinutes = 45; // 45 minutes pour la livraison
                break;
            case OrderType.PICKUP:
                additionalMinutes = 20; // 20 minutes pour la récupération
                break;
            case OrderType.TABLE:
                additionalMinutes = 15; // 15 minutes pour servir à table
                break;
        }

        now.setMinutes(now.getMinutes() + additionalMinutes);
        return now;
    }

    async sendOrderNotifications(order: any) {
        // Notification au client
        if (order.customer_id) {
            // await this.notificationService.sendOrderConfirmation(order);
        }

        // Notification au restaurant
        // await this.notificationService.notifyRestaurantNewOrder(order);
    }

    validateStatusTransition(currentStatus: OrderStatus, newStatus: OrderStatus) {
        // Cas spécial : annulation
        if (newStatus === OrderStatus.CANCELLED) {
            if ([OrderStatus.READY as string, OrderStatus.PICKED_UP as string, OrderStatus.DELIVERED as string,
            OrderStatus.COLLECTED as string, OrderStatus.COMPLETED as string].includes(currentStatus)) {
                throw new ConflictException('Une commande dans un état ultérieur ne peut pas être annulée');
            }
            return;
        }

        // Définir la séquence logique des états
        const stateSequence: OrderStatus[] = [
            OrderStatus.PENDING,
            OrderStatus.ACCEPTED,
            OrderStatus.IN_PROGRESS,
            OrderStatus.READY,
            OrderStatus.PICKED_UP, // Pour livraison
            OrderStatus.DELIVERED, // Pour livraison
            OrderStatus.COLLECTED, // Pour retrait
            OrderStatus.COMPLETED
        ];

        const currentIndex = stateSequence.indexOf(currentStatus);
        const newIndex = stateSequence.indexOf(newStatus);

        // Vérifier que le nouvel état est bien dans la séquence
        if (newIndex === -1) {
            throw new BadRequestException(`État invalide: ${newStatus}`);
        }

        // Vérifier que le nouvel état est bien après l'état actuel
        if (newIndex < currentIndex) {
            throw new ConflictException('Une commande ne peut pas revenir à un état antérieur');
        }

        // Vérifier que l'on ne saute pas d'étapes (sauf pour COMPLETED qui peut être atteint depuis plusieurs états)
        if (newStatus !== OrderStatus.COMPLETED && newIndex > currentIndex + 1) {
            throw new ConflictException('Impossible de sauter des étapes dans le processus de commande');
        }
    }

    async handleStatusSpecificActions(orderId: string, oldStatus: OrderStatus, newStatus: OrderStatus, meta?: any) {
        switch (newStatus) {
            case OrderStatus.ACCEPTED:
                // Planifier la préparation
                break;

            case OrderStatus.READY:
                if (meta?.deliveryDriverId) {
                    // Assigner un livreur
                    // await this.deliveryService.assignDriver(orderId, meta.deliveryDriverId);
                }
                break;

            case OrderStatus.PICKED_UP:
                // Démarrer le suivi de livraison
                // await this.deliveryService.startDeliveryTracking(orderId);
                break;

            case OrderStatus.DELIVERED:
            case OrderStatus.COLLECTED:
            case OrderStatus.COMPLETED:
                // Si un paiement est en attente, le marquer comme réussi
                await this.handlePaymentCompletion(orderId);
                break;

            case OrderStatus.CANCELLED:
                // Annuler les paiements en attente
                await this.cancelPendingPayments(orderId);
                // Retourner les points de fidélité si applicable
                break;
        }
    }

    async handlePaymentCompletion(orderId: string) {
        const pendingPayments = await this.prisma.paiement.findMany({
            where: {
                order_id: orderId,
                status: PaiementStatus.PENDING,
            },
        });

        for (const payment of pendingPayments) {
            await this.prisma.paiement.update({
                where: { id: payment.id },
                data: { status: PaiementStatus.SUCCESS },
            });
        }
    }

    async cancelPendingPayments(orderId: string) {
        await this.prisma.paiement.updateMany({
            where: {
                order_id: orderId,
                status: PaiementStatus.PENDING,
            },
            data: { status: PaiementStatus.FAILED },
        });
    }

    buildWhereClause(filters?: QueryOrderDto) {
        if (!filters) return { entity_status: { not: EntityStatus.DELETED } };

        const {
            status,
            type,
            customerId,
            restaurantId,
            startDate,
            endDate,
            minAmount,
            maxAmount,
        } = filters;

        return {
            entity_status: { not: EntityStatus.DELETED },
            ...(status && { status }),
            ...(type && { type }),
            ...(customerId && { customer_id: customerId }),
            ...(startDate && endDate && {
                created_at: {
                    gte: new Date(startDate),
                    lte: new Date(endDate)
                }
            }),
            ...(minAmount && { amount: { gte: minAmount } }),
            ...(maxAmount && { amount: { lte: maxAmount } }),
            ...(restaurantId && {
                order_items: {
                    some: {
                        dish: {
                            dish_restaurants: {
                                some: {
                                    restaurant_id: restaurantId
                                }
                            }
                        }
                    }
                }
            })
        };
    }
}