import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { CreateOrderDto } from 'src/modules/order/dto/create-order.dto';
import {
  OrderStatus,
  OrderType,
  PaiementStatus,
  EntityStatus,
  Dish,
  Address,
  SupplementCategory,
  Order,
  LoyaltyLevel,
  DeliveryService,
  PaymentMethod,
} from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { SettingsService } from 'src/modules/settings/settings.service';
import { QueryOrderDto } from '../dto/query-order.dto';
import { GenerateDataService } from 'src/common/services/generate-data.service';
import { PaiementsService } from 'src/modules/paiements/services/paiements.service';
import { LoyaltyService } from 'src/modules/fidelity/services/loyalty.service';
import { PromotionService } from 'src/modules/fidelity/services/promotion.service';
import { RestaurantService } from 'src/modules/restaurant/services/restaurant.service';
import { addDays, addHours, addMinutes, addSeconds } from 'date-fns';
import { PromotionErrorKeys } from 'src/modules/fidelity/enums/promotion-error-keys.enum';
import { JsonValue } from '@prisma/client/runtime/library';
import { TurboService } from 'src/turbo/services/turbo.service';

@Injectable()
export class OrderHelper {
  private readonly logger = new Logger(OrderHelper.name);

  constructor(
    private prisma: PrismaService,
    private settingsService: SettingsService,
    private generateDataService: GenerateDataService,
    private paiementService: PaiementsService,
    private loyaltyService: LoyaltyService,
    private promotionService: PromotionService,
    private restaurantService: RestaurantService,
    private readonly turboService: TurboService
  ) {}

  private async getTaxRate(): Promise<number> {
    const val = await this.settingsService.getOrEnv('order_tax_rate', 'ORDER_TAX_RATE', '0.05');
    return Number(val);
  }

  private async getBaseDeliveryFee(): Promise<number> {
    const val = await this.settingsService.getOrEnv('base_delivery_fee', 'BASE_DELIVERY_FEE', '1000');
    return Number(val);
  }

  // Récupérer les données du client
  async resolveCustomerData(orderData: CreateOrderDto) {
    // Si un customer_id est fourni, utiliser ce client
    if (orderData.customer_id) {
      const customer = await this.prisma.customer.findFirst({
        where: {
          id: orderData.customer_id,
          entity_status: { not: EntityStatus.DELETED },
        },
      });
      if (!customer) {
        throw new BadRequestException('Client introuvable');
      }

      return {
        customer_id: customer.id,
        loyalty_level: customer.loyalty_level ?? undefined,
        total_points: customer.total_points ?? 0,
        fullname:
          orderData.fullname || `${customer.first_name} ${customer.last_name}`,
        phone: orderData.phone || customer.phone,
        email: orderData.email || customer.email,
      };
    }
    throw new BadRequestException('Aucun client sélectionné');
  }

  // Récupérer le restaurant le plus proche
  async getNearestRestaurant(address: string) {
    // 1. Récupération de l'adresse
    const addressData = await this.validateAddress(address ?? '');
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
        apikey: true,
      },
    });

    if (!restaurants.length) {
      throw new BadRequestException('Aucun restaurant disponible');
    }
    // 3. Calcul de la distance et sélection du plus proche
    const closest = restaurants.reduce((prev, curr) => {
      const prevDistance = this.generateDataService.haversineDistance(
        addressData.latitude,
        addressData.longitude,
        prev.latitude ?? 0,
        prev.longitude ?? 0,
      );

      const currDistance = this.generateDataService.haversineDistance(
        addressData.latitude,
        addressData.longitude,
        curr.latitude ?? 0,
        curr.longitude ?? 0,
      );
      return currDistance < prevDistance ? curr : prev;
    });
    if (!closest) {
      throw new BadRequestException('Aucun restaurant disponible');
    }
    const schedule = JSON.parse(closest.schedule?.toString() ?? '[]');
    if (!this.restaurantService.isRestaurantOpen(schedule)) {
      throw new BadRequestException('Le restaurant est fermé');
    }
    return closest;
  }

  // Récupérer le restaurant le plus proche
  async getClosestRestaurant({
    restaurant_id,
    address,
  }: {
    restaurant_id?: string;
    address?: string;
  }) {
    if (restaurant_id) {
      // Si le restaurant_id est fourni, récupérer le restaurant correspondant
      const restaurant = await this.prisma.restaurant.findFirst({
        where: {
          id: restaurant_id,
          entity_status: EntityStatus.ACTIVE,
        },
        select: {
          id: true,
          name: true,
          latitude: true,
          longitude: true,
          schedule: true,
          apikey: true,
        },
      });

      // Si le restaurant n'est pas trouvé, récupérer le restaurant le plus proche
      if (!restaurant) {
        throw new BadRequestException('Restaurant introuvable');
      }

      // Vérifier si le restaurant est ouvert
      const schedule = JSON.parse(restaurant.schedule?.toString() ?? '[]');
      if (!this.restaurantService.isRestaurantOpen(schedule)) {
        throw new BadRequestException('Le restaurant est fermé');
      }
      return restaurant;
    }
    return this.getNearestRestaurant(address ?? '');
  }

  // Récupérer les détails des plats
  async getDishesWithDetails(dishIds: string[]) {
    const dishes = await this.prisma.dish.findMany({
      where: {
        id: { in: dishIds },
        entity_status: EntityStatus.ACTIVE,
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
      throw new BadRequestException(
        'Un ou plusieurs plats sont introuvables ou indisponibles',
      );
    }

    return dishes;
  }

  // Valider l'adresse de livraison
  async validateAddress(address: string) {
    if (!address) {
      throw new BadRequestException(
        'Adresse de livraison invalide ou introuvable',
      );
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
      epice: boolean;
      supplements: {
        id: string;
        name: string;
        price: number;
        category: SupplementCategory;
      }[];
    }[] = [];

    for (const item of items) {
      const dish = dishes.find((d) => d.id === item.dish_id);

      if (!dish) {
        throw new BadRequestException(
          'Un ou plusieurs plats sont introuvables ou indisponibles',
        );
      }

      // Récupérer et valider les suppléments
      let supplementsTotal = 0;
      let supplementsData: {
        id: string;
        name: string;
        price: number;
        quantity: number;
        category: SupplementCategory;
      }[] = [];

      // Nouveau format avec quantité (prioritaire) : supplements: [{id, quantity}]
      // Ancien format sans quantité (rétro-compatible) : supplements_ids: [id]
      const hasNewFormat = item.supplements && item.supplements.length > 0;
      const hasOldFormat = item.supplements_ids && item.supplements_ids.length > 0;

      if (hasNewFormat || hasOldFormat) {
        // Construire la map id → quantité
        const supplementQuantityMap: Record<string, number> = {};
        let supplementIds: string[] = [];

        if (hasNewFormat) {
          // Nouveau format : {id, quantity}[]
          for (const supp of item.supplements!) {
            supplementQuantityMap[supp.id] = supp.quantity;
            supplementIds.push(supp.id);
          }
        } else {
          // Ancien format : string[] (chaque supplément = quantité 1)
          let supplement_items = item.supplements_ids!;
          if (typeof item.supplements_ids === 'string') {
            supplement_items = [item.supplements_ids as unknown as string];
          }
          for (const id of supplement_items) {
            supplementQuantityMap[id] = 1;
            supplementIds.push(id);
          }
        }

        const supplements = await this.prisma.supplement.findMany({
          where: {
            id: { in: supplementIds },
            available: true,
            dish_supplements: {
              some: {
                dish_id: dish.id,
              },
            },
          },
        });

        if (supplements.length !== supplementIds.length) {
          throw new BadRequestException(
            'Un ou plusieurs suppléments sont invalides pour ce plat',
          );
        }

        supplementsData = supplements.map((s) => ({
          id: s.id,
          name: s.name,
          price: s.price,
          quantity: supplementQuantityMap[s.id] ?? 1,
          category: s.category,
        }));

        // Calculer le prix des suppléments : prix × quantité de chaque supplément
        supplementsTotal = supplementsData.reduce(
          (sum, s) => sum + s.price * s.quantity,
          0,
        );
      }

      // Calculer le prix du plat
      const itemPrice =
        dish.is_promotion && dish.promotion_price !== null
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
        epice: item.epice,
        supplements: supplementsData,
      });
    }

    // Montant Total des suppléments (prix × quantité de chaque supplément)
    const totalSupplements = orderItems.reduce(
      (sum, item) => sum + item.supplementsPrice,
      0,
    );

    // Calculer le montant total des plats
    const totalDishes = orderItems.reduce(
      (sum, item) => sum + item.dishPrice * item.quantity,
      0,
    );

    return { orderItems, netAmount, totalDishes, totalSupplements };
  }

  /**
  * Calcule les frais de service : 1% du sous-total, 
  * arrondi par défaut (vers le bas) au multiple de 50 le plus proche.
  * Exemples : 
  * - 4900 -> 1% = 49 -> 0 FCFA
  * - 5500 -> 1% = 55 -> 50 FCFA
  * - 12000 -> 1% = 120 -> 100 FCFA
  * - 15000 -> 1% = 150 -> 150 FCFA
  */
  async calculateTax(subTotal: number): Promise<number> {
    if (!subTotal || subTotal <= 0) return 0;

    // 1. Calculer 1% du sous-total
    const baseFee = subTotal * 0.01;

    // 2. Arrondir par défaut (Math.floor) au multiple de 50
    // On divise par 50, on arrondit vers le bas, puis on remultiplie par 50.
    const roundedFee = Math.floor(baseFee / 50) * 50;

    // 💡 Astuce : Si tu veux forcer un minimum de 50 FCFA (pour éviter que ce soit gratuit 
    // sur les petites commandes de moins de 5000 FCFA), tu peux décommenter ceci :
    return Math.max(50, roundedFee);
  }

  // Calculer les frais de livraison personnalisé
  async calculeFraisLivraisonPersonnalise({ lat, long, restaurant }: {
    lat: number, long: number, restaurant: {
      name: string;
      id: string;
      latitude: number | null;
      longitude: number | null;
      schedule: JsonValue;
    } | undefined
  }): Promise<{
    montant: number;
    zone: string;
    distance: number;
    service: DeliveryService;
    zone_id: string | null;
  }> {
    if (!restaurant) {
      throw new BadRequestException('Aucun restaurant disponible');
    }

    // Calculer la distance entre le restaurant et l'adresse de livraison
    const distance = this.generateDataService.haversineDistance(
      restaurant.latitude ?? 0,
      restaurant.longitude ?? 0,
      lat,
      long,
    );

    // Vérifier si le restaurant est zone 4
    if (distance <= 1) {
      return {
        montant: 500,
        zone: `-1km de ${restaurant.name}`,
        distance: Math.round(distance),
        service: DeliveryService.TURBO,
        zone_id: null,
      };
    } else if (distance > 1 && distance <= 2) {
      return {
        montant: 750,
        zone: `1-2km de ${restaurant.name}`,
        distance: Math.round(distance),
        service: DeliveryService.TURBO,
        zone_id: null,
      };
    } else if (distance > 2 && distance <= 3) {
      return {
        montant: 1000,
        zone: `2-3km de ${restaurant.name}`,
        distance: Math.round(distance),
        service: DeliveryService.TURBO,
        zone_id: null,
      };
    } else if (distance > 3 && distance <= 5) {
      return {
        montant: 1500,
        zone: `3-5km de ${restaurant.name}`,
        distance: Math.round(distance),
        service: DeliveryService.TURBO,
        zone_id: null,
      };
    } else if (distance > 5 && distance <= 7) {
      return {
        montant: 2000,
        zone: `5-10km de ${restaurant.name}`,
        distance: Math.round(distance),
        service: DeliveryService.TURBO,
        zone_id: null,
      };
    } else if (distance > 7 && distance <= 10) {
      return {
        montant: 2500,
        zone: `7-10km de ${restaurant.name}`,
        distance: Math.round(distance),
        service: DeliveryService.TURBO,
        zone_id: null,
      };
    } else if (distance > 10 && distance <= 12.5) {
      return {
        montant: 2700,
        zone: `10-12.5km de ${restaurant.name}`,
        distance: Math.round(distance),
        service: DeliveryService.TURBO,
        zone_id: null,
      };
    } else if (distance > 12.5 && distance <= 15) {
      return {
        montant: 3500,
        zone: `12.5-15km de ${restaurant.name}`,
        distance: Math.round(distance),
        service: DeliveryService.TURBO,
        zone_id: null,
      };
    }
    else {
      return {
        montant: 3500,
        zone: `+15km de ${restaurant.name}`,
        distance: Math.round(distance),
        service: DeliveryService.TURBO,
        zone_id: null,
      };
    }
  }

  // Calculer les frais de livraison
  async calculeFraisLivraison({ lat, long, restaurant }: {
    lat: number, long: number, restaurant: {
      name: string;
      id: string;
      latitude: number | null;
      longitude: number | null;
      schedule: JsonValue;
      apikey: string | null;
    } | undefined
  }): Promise<{
    montant: number;
    zone: string;
    distance: number;
    service: DeliveryService;
    zone_id: string | null;
  }> {
    if (!restaurant) {
      throw new BadRequestException('Aucun restaurant disponible');
    }
    // Récupérer la configuration de frais de livraison
    let config: {
      montant: number;
      zone: string;
      distance: number;
      service: DeliveryService;
      zone_id: string | null;
    } = await this.calculeFraisLivraisonPersonnalise({ lat, long, restaurant });

    // Récupérer les zones de livraison de turbo
    const resultTurbo = await this.turboService.obtenirFraisLivraisonParRestaurant(restaurant.apikey ?? "", 0, 200);
    const zones = resultTurbo ? resultTurbo.content : [];

    if (zones.length === 0) {
      return config;
    }

    // Récupérer la zone la plus proche
    const zone = zones.reduce((prev, current) => {
      const prevDistance = this.generateDataService.haversineDistance(prev.latitude, prev.longitude, lat, long);
      const currentDistance = this.generateDataService.haversineDistance(current.latitude, current.longitude, lat, long);
      return currentDistance < prevDistance ? current : prev;
    }, zones[0]);

    return {
      montant: zone.prix,
      distance: config.distance,
      zone: restaurant.name + " - " + zone.name,
      service: DeliveryService.TURBO,
      zone_id: zone.id,
    };
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
    referenceDate: Date = new Date(),
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
        { pattern: /(\d+)j(?:ours?)?/g, unit: 'days' }, // 1j, 2j, 1jour, 2jours
        { pattern: /(\d+)h(?:eures?)?(?!\d)/g, unit: 'hours' }, // 1h, 2h, 1heure, 2heures (pas suivi de chiffres)
        { pattern: /(\d+)m(?:inutes?)?(?!s)/g, unit: 'minutes' }, // 1m, 30m, 1minute, 30minutes (pas suivi de 's')
        { pattern: /(\d+)s(?:econdes?)?/g, unit: 'seconds' }, // 1s, 60s, 1seconde, 60secondes
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
      console.warn(
        'Erreur lors du parsing du temps estimé:',
        estimated_time,
        error,
      );
      return undefined;
    }
  }

  /**
   * Normalise les différents formats de temps vers le format court
   * @private
   */
  private normalizeTimeString(timeStr: string): string {
    return (
      timeStr
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
        .trim()
    );
  }


  // Vérifier la transition d'état
  validateStatusTransition(
    orderType: OrderType,
    currentStatus: OrderStatus,
    newStatus: OrderStatus,
  ) {
    // Cas spécial : annulation
    if (newStatus === OrderStatus.CANCELLED) {
      if (
        [
          OrderStatus.READY as string,
          OrderStatus.PICKED_UP as string,
          OrderStatus.COLLECTED as string,
          OrderStatus.COMPLETED as string,
        ].includes(currentStatus)
      ) {
        throw new ConflictException(
          'Une commande dans un état ultérieur ne peut pas être annulée',
        );
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
      OrderStatus.COMPLETED, // Quand le livreur récupère l'argent
    ];

    // Définir la séquence logique des états pour les commanes à emporter ou à table
    const stateSequence2: OrderStatus[] = [
      OrderStatus.PENDING,
      OrderStatus.ACCEPTED,
      OrderStatus.IN_PROGRESS,
      OrderStatus.READY,
      OrderStatus.COLLECTED, // Pour retrait
      OrderStatus.COMPLETED, // Quand le livreur récupère l'argent
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
      throw new ConflictException(
        'Une commande ne peut pas revenir à un état antérieur',
      );
    }

    // Vérifier que l'on ne saute pas d'étapes (sauf pour COMPLETED qui peut être atteint depuis plusieurs états)
    if (newStatus !== OrderStatus.COMPLETED && newIndex > currentIndex + 1) {
      throw new ConflictException(
        'Impossible de sauter des étapes dans le processus de commande',
      );
    }
  }

  // Gérer les actions spécifiques en fonction de l'état
  async handleStatusSpecificActions(
    order: Order,
    newStatus: OrderStatus,
    meta?: any,
  ) {
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
          throw new BadRequestException("La commande n'a pas été payée");
        }
        break;

      case OrderStatus.CANCELLED:
        const paiement = await this.prisma.paiement.findFirst({
          where: {
            order_id: order.id,
            status: PaiementStatus.SUCCESS,
          },
        });
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
        order_id: null,
      },
    });

    if (!payment) {
      throw new NotFoundException('Paiement non trouvé');
    }

    if (payment.status !== PaiementStatus.SUCCESS) {
      throw new BadRequestException("Le paiement n'est pas encore validé");
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
      OR: [
        { paied: true },
        { payment_method: PaymentMethod.OFFLINE },
        { auto: false }
      ],
      ...(status && { status }),
      ...(type && { type }),
      ...(customerId && { customer_id: customerId }),
      ...(startDate &&
        endDate && {
        created_at: {
          gte: new Date(startDate),
          lte: new Date(endDate),
        },
      }),
      ...(minAmount && { amount: { gte: minAmount } }),
      ...(maxAmount && { amount: { lte: maxAmount } }),
      ...(restaurantId && {
        order_items: {
          some: {
            dish: {
              dish_restaurants: {
                some: {
                  restaurant_id: restaurantId,
                },
              },
            },
          },
        },
      }),
    };
  }

  // Calculer le montant à payer avec les points
  async calculateLoyaltyFee(total_points: number, points: number) {
    if (total_points < points || total_points < 100) return 0;

    const amount = await this.loyaltyService.calculateAmountForPoints(points);

    return amount;
  }

  //Calculer le prix si promotion et création de l'utilisation de la promotion
  async calculatePromotionPrice(
    promotion_id: string | undefined,
    customerData: {
      customer_id: string;
      loyalty_level: LoyaltyLevel | undefined;
    },
    totalDishes: number,
    orderItems: { dish_id: string; quantity: number; price: number }[],
  ): Promise<{
    discount_amount: number;
    buyXGetY_amount: number;
    final_amount: number;
    applicable: boolean;
    reason?: string;
    error_key?: PromotionErrorKeys;
    data?: any;
    offers_dishes: { dish_id: string; quantity: number; price: number }[];
  } | null> {

    if (!promotion_id) return null;
    const canUse = await this.promotionService.canCustomerUsePromotion(
      promotion_id,
      customerData.customer_id,
    );
    if (!canUse.allowed) {
      return null;
    }
    // Calculer la réduction
    const discount = await this.promotionService.calculateDiscount(
      promotion_id,
      totalDishes,
      customerData.customer_id,
      orderItems,
      customerData.loyalty_level,
    );
    if (!discount.applicable) {
      return null;
    }

    return discount;
  }
}
