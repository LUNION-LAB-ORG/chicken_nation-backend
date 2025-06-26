import { Injectable, BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import { CreateOrderDto } from 'src/modules/order/dto/create-order.dto';
import { OrderStatus, OrderType, PaiementStatus, EntityStatus, Dish, Address, SupplementCategory, Order, LoyaltyLevel } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/database/services/prisma.service';
import { QueryOrderDto } from '../dto/query-order.dto';
import { GenerateDataService } from 'src/common/services/generate-data.service';
import { PaiementsService } from 'src/modules/paiements/services/paiements.service';
import { LoyaltyService } from 'src/modules/fidelity/services/loyalty.service';
import { PromotionService } from 'src/modules/fidelity/services/promotion.service';
import { RestaurantService } from 'src/modules/restaurant/services/restaurant.service';
import {
    addDays,
    addHours,
    addMinutes,
    addSeconds
} from 'date-fns';

@Injectable()
export class OrderHelper {
    private readonly taxRate: number;
    private readonly baseDeliveryFee: number;

    constructor(
        private prisma: PrismaService,
        private configService: ConfigService,
        private generateDataService: GenerateDataService,
        private paiementService: PaiementsService,
        private loyaltyService: LoyaltyService,
        private promotionService: PromotionService,
        private restaurantService: RestaurantService
    ) {
        this.taxRate = Number(this.configService.get<number>('ORDER_TAX_RATE', 0.005));
        this.baseDeliveryFee = Number(this.configService.get<number>('BASE_DELIVERY_FEE', 1000));
    }

    // Récupérer les données du client
    async resolveCustomerData(orderData: CreateOrderDto) {
        // Si un customer_id est fourni, utiliser ce client
        if (orderData.customer_id) {
            const customer = await this.prisma.customer.findFirst({
                where: {
                    id: orderData.customer_id,
                    entity_status: EntityStatus.ACTIVE,
                },
            });
            if (!customer) {
                throw new BadRequestException('Client introuvable');
            }

            return {
                customer_id: customer.id,
                loyalty_level: customer.loyalty_level ?? undefined,
                total_points: customer.total_points ?? 0,
                fullname: orderData.fullname || `${customer.first_name} ${customer.last_name}`,
                phone: orderData.phone || customer.phone,
                email: orderData.email || customer.email,
            };
        }
        throw new BadRequestException('Aucun client sélectionné');
    }

    // Récupérer le restaurant le plus proche
    async getClosestRestaurant(orderData: CreateOrderDto) {
        //  Pour la réservation de table ou à emporter, il faut impérativement fournir un restaurant
        if (orderData.type === OrderType.TABLE || orderData.type === OrderType.PICKUP) {
            // Renseigner la forme et le nombre de place pour les réservations de table
            if (orderData.type == OrderType.TABLE && (!orderData.table_type || !orderData.places)) {
                throw new BadRequestException('Le type de table et le nombre de place doivent être renseignés');
            }

            if (!orderData.restaurant_id) {
                throw new BadRequestException('Aucun restaurant sélectionné');
            }
            const restaurant = await this.prisma.restaurant.findFirst({
                where: {
                    id: orderData.restaurant_id,
                },
                select: {
                    id: true,
                    name: true,
                    latitude: true,
                    longitude: true,
                    schedule: true,
                }
            });
            if (!restaurant) {
                throw new BadRequestException('Restaurant introuvable');
            }

            const schedule = JSON.parse(restaurant.schedule?.toString() ?? "[]");
            if (!this.restaurantService.isRestaurantOpen(schedule)) {
                throw new BadRequestException('Le restaurant est fermé');
            }
            return restaurant;
        }

        // 1. Récupération de l'adresse
        const address = await this.validateAddress(orderData.address ?? "");

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
                schedule: true,
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
        if (!closest) {
            throw new BadRequestException('Aucun restaurant disponible');
        }
        const schedule = JSON.parse(closest.schedule?.toString() ?? "[]");
        if (!this.restaurantService.isRestaurantOpen(schedule)) {
            throw new BadRequestException('Le restaurant est fermé');
        }
        return closest;
    }

    // Récupérer les détails des plats
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

    // Valider l'adresse de livraison
    async validateAddress(address: string) {
        if (!address) {
            throw new BadRequestException('Adresse de livraison invalide ou introuvable');
        }
        return JSON.parse(address) as Address;
    }

    // Appliquer un code promo
    async applyPromoCode(promoCode?: string): Promise<number> {
        if (!promoCode) return 0;

        // Logique pour vérifier et appliquer un code promo
        // Idéalement, nous aurions une table pour les codes promo

        // Pour simplifier, on renvoie 0 (pas de réduction)
        return 0;
    }

    // Calculer les détails de la commande
    async calculateOrderDetails(items: CreateOrderDto['items'], dishes: Dish[]) {

        let netAmount = 0;

        const orderItems: {
            dish_id: string;
            quantity: number;
            amount: number;
            dishPrice: number;
            supplementsPrice: number;
            supplements: { id: string; name: string; price: number; category: SupplementCategory }[];
        }[] = [];

        for (const item of items) {
            const dish = dishes.find(d => d.id === item.dish_id);

            if (!dish) {
                throw new BadRequestException('Un ou plusieurs plats sont introuvables ou indisponibles');
            }

            // Récupérer et valider les suppléments
            let supplementsTotal = 0;
            let supplementsData: { id: string; name: string; price: number; quantity: number; category: SupplementCategory }[] = [];

            if (item.supplements_ids && item.supplements_ids.length > 0) {
                let supplement_items = item.supplements_ids;
                if (typeof item.supplements_ids === 'string') {
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
                    quantity: 1,
                    category: s.category,
                }));

                // Calculer le prix des suppléments avec comme quantité 1 au lieu de la quantité choisie par le client
                supplementsTotal = supplementsData.reduce((sum, s) => sum + s.price * s.quantity, 0);
            }

            // Calculer le prix du plat
            const itemPrice = (dish.is_promotion && dish.promotion_price !== null)
                ? dish.promotion_price
                : dish.price;
                
            // On calcul le prix du plat sans les suppléments, puis on ajoute le prix des suppléments (QuantitéArticle * PrixArticle + PrixSupplément)
            // Plus tard on devrait faire (QuantitéArticle * (PrixArticle + PrixSupplément)) ou (QuantitéArticle*PrixArticle + QuantitéSupplément*PrixSupplément)
            let itemAmount = itemPrice * item.quantity; // prix un item (article+supplement) mais ici c'est le prix du plat sans les suppléments

            const lineTotal = itemAmount + supplementsTotal; // prix total d'un item

            netAmount += lineTotal;

            orderItems.push({
                dish_id: item.dish_id,
                quantity: item.quantity,
                amount: itemPrice,
                dishPrice: itemPrice,
                supplementsPrice: supplementsTotal,
                supplements: supplementsData,
            });
        }

        // Montant Total des suppléments
        // Plus tard nous devons ajouter la quantité de supplément dans la requête pour un calcul fiable
        // Pour l'instant on calcule le montant total des suppléments sans tenir compte de la quantité de supplément, ni du plat
        const totalSupplements = orderItems.reduce((sum, item) => sum + item.supplementsPrice, 0);


        // Calculer le montant total des plats
        const totalDishes = orderItems.reduce((sum, item) => sum + item.dishPrice * item.quantity, 0);

        return { orderItems, netAmount, totalDishes, totalSupplements };
    }

    // Calculer les taxes
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

    // Calculer les frais de livraison
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

    /**
     * Calculer le temps estimé
     * Formats supportés: "1j", "30m", "45m", "2h30m", "60s", "1h", "2h15m30s", "1j2h30m15s"
     * Supporte aussi les formats alternatifs: "2 hours 30 minutes", "1 day", etc.
     * @param estimated_time - Temps estimé au format string
     * @param referenceDate - Date de référence (optionnel, par défaut maintenant)
     * @returns Date - Date estimée ou undefined si le format est invalide
     */
    calculateEstimatedTime(
        estimated_time: string,
        referenceDate: Date = new Date()
    ): Date | undefined {
        if (!estimated_time || typeof estimated_time !== 'string') {
            return undefined;
        }

        // Nettoyer et normaliser la chaîne d'entrée
        let timeStr = estimated_time.trim().toLowerCase();

        // Normaliser les formats alternatifs en français/anglais vers le format court
        timeStr = this.normalizeTimeString(timeStr);

        let resultDate = new Date(referenceDate);

        try {
            // Pattern unique pour capturer TOUTES les unités de temps
            // Ordre d'évaluation: jours -> heures -> minutes -> secondes
            const timeUnits = [
                { pattern: /(\d+)j(?:ours?)?/g, unit: 'days' },      // 1j, 2j, 1jour, 2jours
                { pattern: /(\d+)h(?:eures?)?(?!\d)/g, unit: 'hours' }, // 1h, 2h, 1heure, 2heures (pas suivi de chiffres)
                { pattern: /(\d+)m(?:inutes?)?(?!s)/g, unit: 'minutes' }, // 1m, 30m, 1minute, 30minutes (pas suivi de 's')
                { pattern: /(\d+)s(?:econdes?)?/g, unit: 'seconds' }  // 1s, 60s, 1seconde, 60secondes
            ];

            // Traitement spécial pour les formats "2h30m" (heures+minutes collées)
            const hoursMinutesPattern = /(\d+)h(\d+)m/g;
            let hoursMinutesMatch;

            while ((hoursMinutesMatch = hoursMinutesPattern.exec(timeStr)) !== null) {
                const hours = parseInt(hoursMinutesMatch[1], 10);
                const minutes = parseInt(hoursMinutesMatch[2], 10);

                resultDate = addHours(resultDate, hours);
                resultDate = addMinutes(resultDate, minutes);

                // Supprimer la partie traitée pour éviter les doublons
                timeStr = timeStr.replace(hoursMinutesMatch[0], '');
            }

            // Traiter chaque unité de temps
            for (const { pattern, unit } of timeUnits) {
                pattern.lastIndex = 0; // Reset regex global flag
                let match;

                while ((match = pattern.exec(timeStr)) !== null) {
                    const value = parseInt(match[1], 10);

                    if (isNaN(value) || value < 0) continue;

                    switch (unit) {
                        case 'days':
                            resultDate = addDays(resultDate, value);
                            break;
                        case 'hours':
                            resultDate = addHours(resultDate, value);
                            break;
                        case 'minutes':
                            resultDate = addMinutes(resultDate, value);
                            break;
                        case 'seconds':
                            resultDate = addSeconds(resultDate, value);
                            break;
                    }
                }
            }

            return resultDate;

        } catch (error) {
            console.warn('Erreur lors du parsing du temps estimé:', estimated_time, error);
            return undefined;
        }
    }

    /**
     * Normalise les différents formats de temps vers le format court
     * @private
     */
    private normalizeTimeString(timeStr: string): string {
        return timeStr
            // Formats en français
            .replace(/(\d+)\s*jours?/g, '$1j')
            .replace(/(\d+)\s*heures?/g, '$1h')
            .replace(/(\d+)\s*minutes?/g, '$1m')
            .replace(/(\d+)\s*secondes?/g, '$1s')

            // Formats en anglais
            .replace(/(\d+)\s*days?/g, '$1j')
            .replace(/(\d+)\s*hours?/g, '$1h')
            .replace(/(\d+)\s*mins?/g, '$1m')
            .replace(/(\d+)\s*minutes?/g, '$1m')
            .replace(/(\d+)\s*secs?/g, '$1s')
            .replace(/(\d+)\s*seconds?/g, '$1s')

            // Formats avec 'and' ou 'et'
            .replace(/\s+(and|et)\s+/g, '')

            // Nettoyer les espaces multiples
            .replace(/\s+/g, ' ')
            .trim();
    }

    // Envoyer les notifications
    async sendOrderNotifications(order: any) {
        // Notification au client
        if (order.customer_id) {
            // await this.notificationService.sendOrderConfirmation(order);
        }

        // Notification au restaurant
        // await this.notificationService.notifyRestaurantNewOrder(order);
    }

    // Vérifier la transition d'état
    validateStatusTransition(orderType: OrderType, currentStatus: OrderStatus, newStatus: OrderStatus) {
        // Cas spécial : annulation
        if (newStatus === OrderStatus.CANCELLED) {
            if ([OrderStatus.READY as string, OrderStatus.PICKED_UP as string, OrderStatus.COLLECTED as string, OrderStatus.COMPLETED as string].includes(currentStatus)) {
                throw new ConflictException('Une commande dans un état ultérieur ne peut pas être annulée');
            }
            return;
        }

        // Définir la séquence logique des états pour les commanes à livrer
        const stateSequence: OrderStatus[] = [
            OrderStatus.PENDING,
            OrderStatus.ACCEPTED,
            OrderStatus.IN_PROGRESS,
            OrderStatus.READY,
            OrderStatus.PICKED_UP, // Pour livraison
            OrderStatus.COLLECTED, // Pour retrait
            OrderStatus.COMPLETED // Quand le livreur récupère l'argent
        ];
        // Définir la séquence logique des états pour les commanes à emporter ou à table
        const stateSequence2: OrderStatus[] = [
            OrderStatus.PENDING,
            OrderStatus.ACCEPTED,
            OrderStatus.IN_PROGRESS,
            OrderStatus.READY,
            OrderStatus.COLLECTED, // Pour retrait
            OrderStatus.COMPLETED // Quand le livreur récupère l'argent
        ];

        let currentIndex: number;
        let newIndex: number;
        if (orderType === OrderType.DELIVERY) {
            currentIndex = stateSequence.indexOf(currentStatus);
            newIndex = stateSequence.indexOf(newStatus);
        } else {
            currentIndex = stateSequence2.indexOf(currentStatus);
            newIndex = stateSequence2.indexOf(newStatus);
        }

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

    // Gérer les actions spécifiques en fonction de l'état
    async handleStatusSpecificActions(order: Order, newStatus: OrderStatus, meta?: any) {
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

            case OrderStatus.COLLECTED:

                break;

            case OrderStatus.COMPLETED:
                if (!order.paied) {
                    throw new BadRequestException('La commande n\'a pas été payée');
                }
                break;

            case OrderStatus.CANCELLED:

                const paiement = await this.prisma.paiement.findFirst({
                    where: {
                        order_id: order.id,
                        status: PaiementStatus.SUCCESS,
                    },
                })
                if (paiement) {
                    // Remboursement du paiement
                    await this.paiementService.refundPaiement(paiement.id);

                }
                break;
        }
    }

    // Vérifier le paiement
    async checkPayment(orderData: CreateOrderDto) {

        if (!orderData.paiement_id) {
            return null;
        }
        const payment = await this.prisma.paiement.findUnique({
            where: {
                id: orderData.paiement_id,
                order_id: null
            },
        });

        if (!payment) {
            throw new NotFoundException('Paiement non trouvé');
        }

        if (payment.status !== PaiementStatus.SUCCESS) {
            throw new BadRequestException('Le paiement n\'est pas encore validé');
        }

        return payment;
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

    // Calculer le montant à payer avec les points
    async calculateLoyaltyFee(total_points: number, points: number) {
        if (total_points < points || total_points < 100) return 0;

        const amount = await this.loyaltyService.calculateAmountForPoints(points);

        return amount;
    }

    //Calculer le prix si promotion et création de l'utilisation de la promotion
    async calculatePromotionPrice(promotion_id: string | undefined, customerData: { customer_id: string; loyalty_level: LoyaltyLevel | undefined }, totalDishes: number, orderItems: { dish_id: string; quantity: number; price: number }[]) {
        if (!promotion_id) return 0;
        const canUse = await this.promotionService.canCustomerUsePromotion(promotion_id, customerData.customer_id);
        if (!canUse.allowed) {
            return 0;
        }
        // Calculer la réduction
        const discount = await this.promotionService.calculateDiscount(
            promotion_id,
            totalDishes,
            customerData.customer_id,
            orderItems,
            customerData.loyalty_level
        );

        if (!discount.applicable) {
            return 0;
        }
        return discount.discount_amount;
    }

}