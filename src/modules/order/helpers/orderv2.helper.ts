import {
  BadRequestException,
  Injectable,
} from '@nestjs/common';
import { SettingsService } from 'src/modules/settings/settings.service';
import {
  Address,
  DeliveryService,
  Dish,
  EntityStatus,
  OrderStatus,
  OrderType,
  PaymentMethod
} from '@prisma/client';
import { JsonValue } from '@prisma/client/runtime/library';
import { GenerateDataService } from 'src/common/services/generate-data.service';
import { assertDishesAvailableNow, assertOrderTypeAllowed } from 'src/common/utils/dish-availability.util';
import { PrismaService } from 'src/database/services/prisma.service';
import { RestaurantService } from 'src/modules/restaurant/services/restaurant.service';
import { VoucherService } from 'src/modules/voucher/voucher.service';
import { PromoCodeService } from 'src/modules/promo-code/promo-code.service';
import { TurboService } from 'src/turbo/services/turbo.service';
import { OrderItemDto } from '../dto/order-create.dto';
import { DeliveryFeeSettingsHelper } from './delivery-fee-settings.helper';

@Injectable()
export class OrderV2Helper {
  // private readonly logger = new Logger(OrderV2Helper.name);

  constructor(
    private prisma: PrismaService,
    private settingsService: SettingsService,
    private readonly deliveryFeeSettings: DeliveryFeeSettingsHelper,
    private generateDataService: GenerateDataService,
    private restaurantService: RestaurantService,
    private readonly turboService: TurboService,
    private voucherService: VoucherService,
    private promoCodeService: PromoCodeService,
  ) {}

  private async getTaxRate(): Promise<number> {
    const val = await this.settingsService.getOrEnv('order_tax_rate', 'ORDER_TAX_RATE', '0.05');
    return Number(val);
  }

  /**
    * Génère un numéro de commande unique
    * @returns Un numéro de commande au format ORD-YYMMDD-XXXXX
    */
  generateOrderReference(): string {
    const date = new Date();
    const year = date.getFullYear().toString().slice(-2);
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');
    const random = Math.floor(10000 + Math.random() * 90000);

    return `ORD-${year}${month}${day}-${random}`;
  }

  async validateAddress(address: string) {
    if (!address) {
      throw new BadRequestException("L'adresse de livraison est requise pour cette commande.");
    }

    try {
      const parsedAddress = JSON.parse(address);

      // On s'assure que les coordonnées GPS sont bien présentes
      if (parsedAddress.latitude === undefined || parsedAddress.longitude === undefined) {
        throw new BadRequestException("L'adresse fournie ne contient pas de coordonnées GPS valides.");
      }

      return parsedAddress as Address;
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException("Le format de l'adresse de livraison est invalide.");
    }
  }

  // Récupérer les données du client connecté
  async resolveCustomerData(
    { customer_id, fullname, phone, email }:
      { customer_id?: string, fullname?: string, phone?: string, email?: string }
  ) {
    if (!customer_id) {
      throw new BadRequestException('Aucun client sélectionné pour cette commande.');
    }

    const customer = await this.prisma.customer.findFirst({
      where: {
        id: customer_id,
        entity_status: { not: EntityStatus.DELETED },
      },
      include: {
        notification_settings: true,
      },
    });

    if (!customer) {
      throw new BadRequestException('Client introuvable ou compte supprimé.');
    }

    return {
      customer_id: customer.id,
      loyalty_level: customer.loyalty_level ?? undefined,
      total_points: customer.total_points ?? 0,
      fullname: fullname || `${customer.first_name} ${customer.last_name}`.trim(),
      phone: phone || customer.phone,
      email: email || customer.email,
      expo_token: customer.notification_settings ? customer.notification_settings?.expo_push_token : null,
    };
  }

  // 1. Récupérer les détails des plats (Prix, Suppléments globaux) - Garde cette méthode
  async getDishesWithDetails(dishIds: string[]) {
    const dishes = await this.prisma.dish.findMany({
      where: {
        id: { in: dishIds },
        entity_status: EntityStatus.ACTIVE,
      },
    });

    if (dishes.length !== dishIds.length) {
      throw new BadRequestException('Un ou plusieurs plats de votre commande n\'existent plus au catalogue.');
    }

    // Créneau horaire de disponibilité : blocage serveur (l'app ne fait que masquer)
    assertDishesAvailableNow(dishes);

    return dishes;
  }

  // 2. NOUVEAU : Trouver un restaurant pour la LIVRAISON (Automatique)
  async findEligibleDeliveryRestaurant(addressData: Address, dishIds: string[]) {
    // a. Récupérer tous les restaurants actifs
    const restaurants = await this.prisma.restaurant.findMany({
      where: { entity_status: EntityStatus.ACTIVE },
      select: {
        id: true, name: true, latitude: true, longitude: true, schedule: true, apikey: true,
      },
    });

    const eligibleRestaurants: {
      name: string;
      id: string;
      longitude: number | null;
      latitude: number | null;
      schedule: JsonValue;
      apikey: string | null;
    }[] = [];

    // Dédup : l'app crée une ligne distincte par (dish + epice + supplements),
    // donc dishIds peut contenir le même dish_id plusieurs fois. Le count Prisma
    // est distinct par défaut, il faut comparer à uniqueDishIds.length.
    const uniqueDishIds = [...new Set(dishIds)];

    // b. Filtrer : Ouverts + Possèdent TOUS les plats
    for (const r of restaurants) {
      const schedule = JSON.parse(r.schedule?.toString() ?? '[]');
      if (!this.restaurantService.isRestaurantOpen(schedule)) continue;

      // On compte si ce restaurant possède bien les X plats demandés
      const availableDishesCount = await this.prisma.dish.count({
        where: {
          id: { in: uniqueDishIds },
          dish_excluded_restaurants: { none: { restaurant_id: r.id } },
        },
      });

      if (availableDishesCount === uniqueDishIds.length) {
        eligibleRestaurants.push(r);
      }
    }

    if (eligibleRestaurants.length === 0) {
      throw new BadRequestException("Actuellement, aucun restaurant ouvert ne propose l'ensemble de ces plats.");
    }

    // c. Trouver le plus proche parmi les éligibles
    const closest = eligibleRestaurants.reduce((prev, curr) => {
      const prevDist = this.generateDataService.haversineDistance(
        addressData.latitude, addressData.longitude, prev.latitude ?? 0, prev.longitude ?? 0,
      );
      const currDist = this.generateDataService.haversineDistance(
        addressData.latitude, addressData.longitude, curr.latitude ?? 0, curr.longitude ?? 0,
      );
      return currDist < prevDist ? curr : prev;
    });

    return closest;
  }

  // 3. NOUVEAU : Valider le choix du client pour EMPORTER / SUR PLACE (Manuel)
  async validateRestaurantChoice(restaurant_id: string, dishIds: string[]) {
    const restaurant = await this.prisma.restaurant.findFirst({
      where: { id: restaurant_id, entity_status: EntityStatus.ACTIVE },
      select: {
        id: true, name: true, latitude: true, longitude: true, schedule: true, apikey: true,
      },
    });

    if (!restaurant) {
      throw new BadRequestException('Le restaurant sélectionné est introuvable.');
    }

    const schedule = JSON.parse(restaurant.schedule?.toString() ?? '[]');
    if (!this.restaurantService.isRestaurantOpen(schedule)) {
      throw new BadRequestException(`Le restaurant ${restaurant.name} est actuellement fermé.`);
    }

    // Vérifier l'inventaire de ce restaurant spécifique.
    // Dédup : dishIds peut contenir le même dish_id plusieurs fois (épicé / non-épicé,
    // suppléments différents). Le count Prisma est distinct, on compare donc à
    // uniqueDishIds.length pour éviter de bloquer à tort.
    const uniqueDishIds = [...new Set(dishIds)];
    const availableDishesCount = await this.prisma.dish.count({
      where: {
        id: { in: uniqueDishIds },
        dish_excluded_restaurants: { none: { restaurant_id: restaurant.id } },
      },
    });

    if (availableDishesCount !== uniqueDishIds.length) {
      throw new BadRequestException(`Le restaurant ${restaurant.name} ne dispose pas de tous les plats sélectionnés pour le moment.`);
    }

    return restaurant;
  }

  // Calculer les détails de la commande avec précision (Quantités + Suppléments)
  async calculateOrderDetails(items: OrderItemDto[], dishes: Dish[], type?: OrderType) {
    let netAmount = 0;
    const orderItems: any[] = [];

    for (const item of items) {
      const dish = dishes.find((d) => d.id === item.dish_id);

      if (!dish) {
        throw new BadRequestException('Un ou plusieurs plats sont introuvables.');
      }

      // Bloquer côté serveur si le plat n'est pas disponible pour ce mode de commande
      // (le garde-fou app est insuffisant : payload direct ou items legacy sans champ).
      if (type && Array.isArray(dish.available_order_types) && dish.available_order_types.length > 0
          && !dish.available_order_types.includes(type)) {
        const labels: Partial<Record<OrderType, string>> = {
          [OrderType.DELIVERY]: 'à livrer',
          [OrderType.PICKUP]: 'à emporter',
          [OrderType.TABLE]: 'sur place',
        };
        throw new BadRequestException(
          `Le plat « ${dish.name} » n'est pas disponible ${labels[type] ?? 'pour ce mode de commande'}.`,
        );
      }

      let supplementsTotal = 0;
      const supplementsData: any[] = [];

      // 1. Gestion des suppléments avec prise en compte de la QUANTITÉ
      if (item.supplements && item.supplements.length > 0) {
        const supplementIds = item.supplements.map(s => s.id);

        const dbSupplements = await this.prisma.supplement.findMany({
          where: {
            id: { in: supplementIds },
            available: true,
            // Modèle exclusion : un supplément ne peut être commandé pour un plat
            // que s'il n'est PAS exclu de ce plat (parité avec la v1).
            dish_excluded_supplements: { none: { dish_id: dish.id } },
          },
        });

        if (dbSupplements.length !== item.supplements.length) {
          throw new BadRequestException('Un ou plusieurs suppléments sont invalides ou indisponibles pour ce plat.');
        }

        // Mode de commande : suppléments compatibles avec le type choisi
        assertOrderTypeAllowed(dbSupplements, type ?? null, 'supplément');

        // On associe chaque supplément demandé avec son prix en base de données
        for (const reqSupp of item.supplements) {
          const dbSupp = dbSupplements.find(s => s.id === reqSupp.id);
          if (dbSupp) {
            supplementsData.push({
              id: dbSupp.id,
              name: dbSupp.name,
              price: dbSupp.price,
              quantity: reqSupp.quantity,
              category: dbSupp.category,
            });
            // Calcul : Prix du supplément * quantité de ce supplément
            supplementsTotal += (dbSupp.price * reqSupp.quantity);
          }
        }
      }

      // 2. Calcul du prix de base du plat (gestion de la promotion)
      const dishBasePrice = (dish.is_promotion && dish.promotion_price !== null)
        ? dish.promotion_price
        : dish.price;

      // 3. Prix unitaire global (Prix unitaire * Quantité de plats commandés)
      const singleItemTotal = dishBasePrice * item.quantity;

      // 4. Prix total pour cette ligne (Prix global du plat + Prix des suppléments)
      const lineTotal = singleItemTotal + supplementsTotal;
      netAmount += lineTotal;

      orderItems.push({
        dish_id: item.dish_id,
        quantity: item.quantity,
        amount: singleItemTotal,
        dishPrice: dishBasePrice,
        supplementsPrice: supplementsTotal,
        epice: item.epice,
        supplements: supplementsData,
      });
    }

    // Statistiques pour l'affichage ou les logs
    const totalSupplements = orderItems.reduce((sum, item) => sum + item.supplementsPrice, 0);
    const totalDishes = orderItems.reduce((sum, item) => sum + item.amount, 0);

    return { orderItems, netAmount, totalDishes, totalSupplements };
  }


  // Appliquer un code promo ou un voucher
  // Retourne { discount, type } pour savoir quel type a été appliqué
  // orderItems est requis pour appliquer correctement les codes promo ciblés
  // (SPECIFIC_PRODUCTS / CATEGORIES) : la remise est calculée sur le subtotal
  // des items éligibles uniquement.
  async applyPromoCode(
    code?: string,
    customer_id?: string,
    netAmount?: number,
    orderItems?: { dish_id: string; quantity: number; price: number }[],
  ): Promise<{ discount: number; type: 'PROMO_CODE' | 'VOUCHER' | null; promoCodeId?: string }> {
    if (!code || !customer_id || !netAmount) return { discount: 0, type: null };

    // 1. Essayer d'abord comme Code Promo (PromoCode)
    try {
      const promoResult = await this.promoCodeService.applyPromoCode(
        code,
        customer_id,
        netAmount,
        orderItems,
      );
      if (promoResult.isValid && promoResult.discountAmount > 0) {
        return {
          discount: Math.min(promoResult.discountAmount, netAmount),
          type: 'PROMO_CODE',
          promoCodeId: promoResult.promoCode.id,
        };
      }
    } catch {
      // Code promo non trouvé ou invalide → on essaie comme voucher
    }

    // 2. Fallback : Essayer comme Voucher
    try {
      const voucherResult = await this.voucherService.checkValidityForCustomer(code, customer_id);
      if (voucherResult.isValid) {
        const discountToApply = Math.min(voucherResult.remainingAmount, netAmount);
        if (discountToApply > 0) {
          return { discount: discountToApply, type: 'VOUCHER' };
        }
      }
    } catch {
      // Voucher non trouvé ou invalide
    }

    // 3. Aucun des deux n'a fonctionné
    throw new BadRequestException('Code promo invalide ou introuvable');
  }

  // Calculer les taxes avec arrondi au 10 supérieur
  async calculateTax(netAmount: number): Promise<number> {
    try {
      // 1. Calcul du montant brut de la taxe
      const taxRate = await this.getTaxRate();
      const rawTax = netAmount * taxRate;

      // 2. Application de l'arrondi : Math.ceil(valeur / 10) * 10
      // Ex: 143.2 -> 14.32 (ceil) -> 15 -> 150
      const roundedTax = Math.ceil(rawTax / 10) * 10;

      return roundedTax;

    } catch (error) {
      console.error("Erreur lors du calcul de la taxe:", error);
      // En cas d'erreur, on retourne 0 par sécurité
      return 0;
    }
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

    // Grille de fallback des frais de livraison (utilisée si l'API Turbo ne répond pas)
    // Grille configurable distance→prix (réglage `delivery.fee_grid`).
    const feeSettings = await this.deliveryFeeSettings.load();
    return {
      montant: this.deliveryFeeSettings.priceForDistance(feeSettings.grid, distance),
      zone: this.deliveryFeeSettings.zoneLabel(feeSettings.grid, distance, restaurant.name),
      distance: Math.round(distance),
      service: DeliveryService.TURBO,
      zone_id: null,
    };
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

    // Zones Turbo désactivées via les réglages → on garde la grille interne.
    const feeSettings = await this.deliveryFeeSettings.load();
    if (!feeSettings.turboZonesEnabled) {
      return config;
    }

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

  // Déterminer le status à partir de la méthode de paiement, le type de commande et du paiement
  // Tous les types de commande paient en ligne (ONLINE)
  getOrderStatus(paymentMethod: PaymentMethod, orderType: OrderType): OrderStatus {

    // A Livrer
    if (orderType === OrderType.DELIVERY) {
      return OrderStatus.PENDING;
    }

    // Emporter et Table
    if (orderType === OrderType.PICKUP || orderType === OrderType.TABLE) {
      return OrderStatus.PENDING;
    }

    throw new BadRequestException('Type de commande non supporté');
  }
}
