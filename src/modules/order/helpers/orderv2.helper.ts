import {
  BadRequestException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  Address,
  DeliveryService,
  Dish,
  EntityStatus
} from '@prisma/client';
import { JsonValue } from '@prisma/client/runtime/library';
import { GenerateDataService } from 'src/common/services/generate-data.service';
import { PrismaService } from 'src/database/services/prisma.service';
import { RestaurantService } from 'src/modules/restaurant/services/restaurant.service';
import { TurboService } from 'src/turbo/services/turbo.service';
import { OrderItemDto } from '../dto/order-create.dto';

@Injectable()
export class OrderV2Helper {
  private readonly taxRate: number;
  // private readonly logger = new Logger(OrderV2Helper.name);

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
    private generateDataService: GenerateDataService,
    private restaurantService: RestaurantService,
    private readonly turboService: TurboService
  ) {
    this.taxRate = Number(
      this.configService.get<number>('ORDER_TAX_RATE', 0.05),
    );
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
    };
  }

  // 1. Récupérer les détails des plats (Prix, Suppléments globaux) - Garde cette méthode
  async getDishesWithDetails(dishIds: string[]) {
    const dishes = await this.prisma.dish.findMany({
      where: {
        id: { in: dishIds },
        entity_status: EntityStatus.ACTIVE,
      },
      include: {
        dish_supplements: {
          include: { supplement: true },
        },
      },
    });

    if (dishes.length !== dishIds.length) {
      throw new BadRequestException('Un ou plusieurs plats de votre commande n\'existent plus au catalogue.');
    }
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

    // b. Filtrer : Ouverts + Possèdent TOUS les plats
    for (const r of restaurants) {
      const schedule = JSON.parse(r.schedule?.toString() ?? '[]');
      if (!this.restaurantService.isRestaurantOpen(schedule)) continue;

      // On compte si ce restaurant possède bien les X plats demandés
      const availableDishesCount = await this.prisma.dish.count({
        where: {
          id: { in: dishIds },
          dish_restaurants: { some: { restaurant_id: r.id } },
        },
      });

      if (availableDishesCount === dishIds.length) {
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

    // Vérifier l'inventaire de ce restaurant spécifique
    const availableDishesCount = await this.prisma.dish.count({
      where: {
        id: { in: dishIds },
        dish_restaurants: { some: { restaurant_id: restaurant.id } },
      },
    });

    if (availableDishesCount !== dishIds.length) {
      throw new BadRequestException(`Le restaurant ${restaurant.name} ne dispose pas de tous les plats sélectionnés pour le moment.`);
    }

    return restaurant;
  }

  // Calculer les détails de la commande avec précision (Quantités + Suppléments)
  async calculateOrderDetails(items: OrderItemDto[], dishes: Dish[]) {
    let netAmount = 0;
    const orderItems: any[] = [];

    for (const item of items) {
      const dish = dishes.find((d) => d.id === item.dish_id);

      if (!dish) {
        throw new BadRequestException('Un ou plusieurs plats sont introuvables.');
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
          },
        });

        if (dbSupplements.length !== item.supplements.length) {
          throw new BadRequestException('Un ou plusieurs suppléments sont invalides ou indisponibles pour ce plat.');
        }

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


  // Appliquer un code promo
  async applyPromoCode(promoCode?: string): Promise<number> {
    if (!promoCode) return 0;

    // Logique pour vérifier et appliquer un code promo
    // Idéalement, nous aurions une table pour les codes promo

    // Pour simplifier, on renvoie 0 (pas de réduction)
    return 0;
  }

  // Calculer les taxes avec arrondi au 10 supérieur
  async calculateTax(netAmount: number): Promise<number> {
    try {
      // 1. Calcul du montant brut de la taxe
      const rawTax = netAmount * this.taxRate;

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
}
