import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  Customer,
  DeliveryService,
  EntityStatus,
  Order,
  OrderStatus,
  OrderType,
  PaiementStatus,
  PaymentMethod,
  Prisma,
  User,
  UserRole,
} from '@prisma/client';
import { format, startOfMonth, differenceInMinutes } from 'date-fns';
import { fr } from 'date-fns/locale';
import * as ExcelJS from 'exceljs';
import type { Request } from 'express';
import { QueryResponseDto } from 'src/common/dto/query-response.dto';
import { GenerateDataService } from 'src/common/services/generate-data.service';
import { PrismaService } from 'src/database/services/prisma.service';
import { CreateOrderDto } from '../dto/create-order.dto';
import { FraisLivraisonDto } from '../dto/frais-livrasion.dto';
import { QueryOrderCustomerDto, QueryOrderDto } from '../dto/query-order.dto';
import { OrderUpdatedDto, UpdateOrderDto } from '../dto/update-order.dto';
import { OrderEvent } from '../events/order.event';
import { OrderHelper } from '../helpers/order.helper';
import { OrderWebSocketService } from '../websockets/order-websocket.service';
import { OrderV2Helper } from '../helpers/orderv2.helper';
import { DeliveryFeeHelper } from '../helpers/delivery-fee.helper';
import { DeliveryOfferService } from 'src/modules/delivery-offer/services/delivery-offer.service';
import { PromoCodeUsageStatus, RewardType, RewardStatus } from '@prisma/client';
import { OrderCreateDto, OrderItemDto } from '../dto/order-create.dto';
import { VoucherService } from 'src/modules/voucher/voucher.service';
import { PromoCodeService } from 'src/modules/promo-code/promo-code.service';
import { TwilioService } from 'src/twilio/services/twilio.service';

@Injectable()
export class OrderService {
  private readonly logger = new Logger(OrderService.name);
  constructor(
    private prisma: PrismaService,
    private generateDataService: GenerateDataService,
    private orderHelper: OrderHelper,
    private orderHelperV2: OrderV2Helper,
    private readonly deliveryFeeHelper: DeliveryFeeHelper,
    private readonly deliveryOfferService: DeliveryOfferService,
    private orderEvent: OrderEvent,
    private readonly orderWebSocketService: OrderWebSocketService,
    private voucherService: VoucherService,
    private promoCodeService: PromoCodeService,
    private twilioService: TwilioService,

  ) { }

  async createv2(customer_id: string, createOrderDto: OrderCreateDto): Promise<Order> {
    const {
      items, address, restaurant_id, type, code_promo, date, fullname, phone, email, payment_method, points,
      delivery_service: overrideDeliveryService,
    } = createOrderDto;

    // 🚫 Livraison désactivée pour l'app (réglage backoffice temporaire).
    // createv2 = chemin EXCLUSIF de l'app → ne bloque jamais le call center.
    if (type === OrderType.DELIVERY) {
      const block = await this.deliveryFeeHelper.isAppDeliveryDisabled();
      if (block.disabled) {
        throw new BadRequestException(block.message);
      }
    }

    // 1. Gestion de la Date (Le format ISO géré par le nouveau DTO)
    let finalDate = date && typeof date === 'string' ? new Date(date) : new Date();

    // 2. Client
    const customerData = await this.orderHelperV2.resolveCustomerData({
      customer_id, fullname, phone, email,
    });

    // 3. Récupération globale des Plats & Calculs
    const dishIds = items.map((item) => item.dish_id);
    const dishesWithDetails = await this.orderHelperV2.getDishesWithDetails(dishIds);

    // Cadeaux (GIFT) : valider les lignes-cadeau AVANT le calcul (appartenance, gratté,
    // non expiré, plat correspondant). On récupère les index → pricing à 0 fr +
    // claim atomique dans la transaction. La consommation réelle se fait dans la txn.
    const giftLines = await this.validateGiftLines(items, customerData.customer_id);

    // Ton algorithme ajusté !
    // On passe `type` pour faire respecter `available_order_types` côté serveur :
    // un plat marqué "pas à livrer" ne doit pas pouvoir être commandé en DELIVERY
    // même via payload direct.
    const { orderItems, netAmount, totalDishes } = await this.orderHelperV2.calculateOrderDetails(items, dishesWithDetails, type, new Set(giftLines.keys()));

    // Pour le ciblage par plat/catégorie d'un code promo, on transmet la liste
    // simplifiée des items (dish_id, quantity, prix unitaire). Le prix retenu est
    // le prix unitaire du plat (avec promotion plat éventuelle), hors suppléments.
    const promoItems = orderItems.map((oi) => ({
      dish_id: oi.dish_id,
      quantity: oi.quantity,
      price: oi.dishPrice,
    }));
    const promoResult = await this.orderHelperV2.applyPromoCode(
      code_promo,
      customerData.customer_id,
      netAmount,
      promoItems,
    );
    const promoDiscount = promoResult.discount;

    // Calculer le montant de réduction des points de fidélité
    const loyaltyFee = await this.orderHelper.calculateLoyaltyFee(
      customerData.total_points,
      points ?? 0,
    );

    // ==========================================
    // 4. LE MOTEUR DE ROUTAGE DES RESTAURANTS
    // ==========================================
    let restaurant: any = null;
    let delivery: any = null;
    let finalDeliveryFee = 0;
    let deliveryFeeBase = 0;   // frais de livraison PLEIN (avant offre) — bilan
    let deliveryDiscount = 0;  // remise de l'offre appliquée sur le frais

    if (type === OrderType.DELIVERY) {
      // 📍 LIVRAISON : Attribution automatique selon la distance et le stock
      if (!address) throw new BadRequestException("L'adresse est obligatoire pour une livraison.");
      const addressData = await this.orderHelperV2.validateAddress(address);

      restaurant = await this.orderHelperV2.findEligibleDeliveryRestaurant(addressData, dishIds);
      // Frais TOUJOURS calculé côté serveur (autoritaire) : on ne fait PAS confiance au
      // delivery_fee envoyé par l'app (intégrité). On en tire le frais facturé + le frais
      // PLEIN (avant offre) + la remise → bilan fiable, source unique.
      delivery = await this.deliveryFeeHelper.calculeFraisLivraison({
        lat: addressData.latitude,
        long: addressData.longitude,
        restaurant,
        channel: 'APP',
        orderAmount: netAmount,
        customerId: customerData.customer_id,
      });
      finalDeliveryFee = delivery.montant;
      deliveryFeeBase = delivery.original_montant ?? delivery.montant;
      deliveryDiscount = delivery.discount ?? 0;

    } else {
      // 🛍️ EMPORTER & TABLE : Vérification stricte du choix du client
      if (!restaurant_id) throw new BadRequestException("Le choix du restaurant est obligatoire pour ce type de commande.");

      restaurant = await this.orderHelperV2.validateRestaurantChoice(restaurant_id, dishIds);
      finalDeliveryFee = 0; // Pas de frais de livraison
    }

    // 5. Calcul Final des Totaux
    const discount = promoDiscount + loyaltyFee;
    const totalAfterDiscount = netAmount - discount;
    const tax = await this.orderHelperV2.calculateTax(netAmount);
    const totalAmount = totalAfterDiscount + tax + finalDeliveryFee;

    const orderNumber = this.orderHelperV2.generateOrderReference();

    const next_status = this.orderHelperV2.getOrderStatus(payment_method ?? PaymentMethod.OFFLINE, type);
    // 6. Sauvegarde en Base de données
    const order = await this.prisma.$transaction(async (prisma) => {
      const created = await prisma.order.create({
        data: {
          type,
          fullname: customerData.fullname,
          phone: customerData.phone,
          email: customerData.email,
          ...(loyaltyFee && { points: points }),
          customer: { connect: { id: customerData.customer_id } },
          restaurant: { connect: { id: restaurant.id } },
          reference: orderNumber,
          address: address ?? '',
          delivery_fee: Number(finalDeliveryFee),
          delivery_fee_base: Number(deliveryFeeBase),
          delivery_discount: Number(deliveryDiscount),
          // Override client/admin > auto-détection zone > fallback TURBO
          delivery_service: overrideDeliveryService ?? (delivery ? delivery.service : DeliveryService.TURBO),
          zone_id: delivery?.zone_id,
          tax: Number(tax),
          discount: Number(discount),
          // Persister le code promo / voucher SAISI lorsqu'il a réellement
          // appliqué une réduction (promoResult.type != null). Sans ça, le
          // backoffice affichait « Réduction » sans en donner la raison
          // (le détail/drawer lit order.code_promo → « Réduction · Code XXX »).
          ...(promoResult.type && code_promo ? { code_promo } : {}),
          net_amount: Number(netAmount),
          amount: Number(totalAmount),
          date: finalDate,
          time: finalDate.toISOString().split('T')[1].substring(0, 5),
          payment_method: payment_method ?? PaymentMethod.OFFLINE,
          status: next_status,
          ...(next_status === OrderStatus.ACCEPTED && { accepted_at: new Date() }),
          paied: false,
          auto: true,
          order_items: {
            create: orderItems.map((item) => ({
              dish_id: item.dish_id,
              quantity: item.quantity,
              amount: item.amount,
              epice: item.epice,
              supplements: item.supplements,
            })),
          },
          entity_status: EntityStatus.ACTIVE,
        },
        include: {
          order_items: { include: { dish: true } },
          customer: { select: { id: true, first_name: true, last_name: true, phone: true, email: true, image: true } },
          restaurant: true,
          paiements: true,
        },
      });

      // Consommer les cadeaux : claim ATOMIQUE SCRATCHED→CONSUMED lié à CETTE commande.
      // Si un cadeau a été utilisé entre-temps (course concurrente / autre commande),
      // count===0 → on annule TOUTE la commande (rollback) → exactly-once garanti.
      for (const { reward_id } of giftLines.values()) {
        const claim = await prisma.reward.updateMany({
          where: {
            id: reward_id,
            customer_id: customerData.customer_id,
            type: RewardType.GIFT,
            status: RewardStatus.SCRATCHED,
          },
          data: {
            status: RewardStatus.CONSUMED,
            order_id: created.id,
            consumed_at: new Date(),
            updated_at: new Date(),
          },
        });
        if (claim.count === 0) {
          throw new BadRequestException('Ce cadeau a déjà été utilisé.');
        }
      }

      return created;
    });

    // Enregistrer l'usage du code promo ou voucher
    if (code_promo && order && promoDiscount > 0) {
      try {
        if (promoResult.type === 'PROMO_CODE' && promoResult.promoCodeId) {
          // C'est un code promo → enregistrer l'usage dans PromoCodeUsage
          await this.promoCodeService.recordUsage(
            promoResult.promoCodeId,
            customerData.customer_id,
            order.id,
            Number(promoDiscount),
          );
        } else if (promoResult.type === 'VOUCHER') {
          // C'est un voucher → consommer le voucher
          await this.voucherService.redeemVoucher(code_promo, customerData.customer_id, {
            orderId: order.id,
            amount: Number(promoDiscount),
          });
        }
      } catch (error) {
        this.logger.error(`Erreur lors de l'enregistrement de l'usage du code ${code_promo}: ${error.message}`);
      }
    }
    // Enregistrer l'usage de l'offre de livraison appliquée (pour les limites).
    if (order && delivery?.offer_id) {
      try {
        await this.deliveryOfferService.recordUsage(
          delivery.offer_id,
          customerData.customer_id,
          order.id,
          Number(delivery.discount ?? 0),
          PromoCodeUsageStatus.ACTIVE,
        );
        await this.prisma.deliveryOffer.update({
          where: { id: delivery.offer_id },
          data: { usage_count: { increment: 1 } },
        });
      } catch (error) {
        this.logger.error(
          `Erreur enregistrement usage offre livraison: ${error.message}`,
        );
      }
    }

    // Envoyer l'événement de création de commande
    this.orderEvent.orderCreatedEvent({
      order,
      expo_token: customerData.expo_token,
      loyalty_level: customerData.loyalty_level,
      totalDishes,
      orderItems: orderItems.map((item) => ({
        dish_id: item.dish_id,
        quantity: item.quantity,
        price: item.dishPrice,
      })),
    });

    // Émettre l'événement WebSocket de création de commande
    this.orderWebSocketService.emitOrderCreated(order);

    return order;
  }

  /**
   * Valide les lignes-cadeau d'une commande app : chaque item portant un `reward_id`
   * doit correspondre à un cadeau GIFT du client, GRATTÉ, non expiré, non déjà
   * consommé, et dont le plat offert (payload.dish_id) correspond au dish_id de la
   * ligne. Renvoie index-de-ligne → { reward_id } pour (a) le pricing à 0 fr et
   * (b) le claim atomique dans la txn. Ici on ne fait QUE valider (aucune écriture).
   */
  private async validateGiftLines(
    items: OrderItemDto[],
    customer_id: string,
  ): Promise<Map<number, { reward_id: string }>> {
    const giftLines = new Map<number, { reward_id: string }>();
    const seen = new Set<string>();
    for (let i = 0; i < items.length; i++) {
      const rid = items[i].reward_id;
      if (!rid) continue;
      if (seen.has(rid)) {
        throw new BadRequestException('Un même cadeau ne peut pas être utilisé deux fois.');
      }
      seen.add(rid);
      giftLines.set(i, { reward_id: rid });
    }
    if (giftLines.size === 0) return giftLines;

    const rewards = await this.prisma.reward.findMany({
      where: { id: { in: [...seen] }, customer_id, type: RewardType.GIFT },
      select: { id: true, status: true, expires_at: true, payload: true },
    });
    const byId = new Map(rewards.map((r) => [r.id, r]));
    const now = Date.now();

    for (const [index, { reward_id }] of giftLines) {
      const reward = byId.get(reward_id);
      if (!reward) throw new BadRequestException('Cadeau introuvable.');
      if (reward.status === RewardStatus.CONSUMED) {
        throw new BadRequestException('Ce cadeau a déjà été utilisé.');
      }
      if (reward.status !== RewardStatus.SCRATCHED) {
        throw new BadRequestException("Ce cadeau doit d'abord être gratté.");
      }
      if (reward.expires_at && reward.expires_at.getTime() < now) {
        throw new BadRequestException('Ce cadeau a expiré.');
      }
      const giftDishId = (reward.payload as Record<string, any> | null)?.dish_id;
      if (!giftDishId || giftDishId !== items[index].dish_id) {
        throw new BadRequestException('Le plat ne correspond pas au cadeau offert.');
      }
    }
    return giftLines;
  }

  /**
   * Crée une nouvelle commande
   */
  async create(req: Request, createOrderDto: CreateOrderDto): Promise<any> {
    const {
      items,
      paiement_id,
      customer_id,
      address,
      restaurant_id,
      promotion_id,
      delivery_fee,
      points,
      user_id,
      delivery_service: overrideDeliveryService,
      ...orderData
    } = createOrderDto;

    const customerId = user_id ? undefined : (req.user as Customer).id;
    // Identifier le client ou créer à partir des données
    const customerData = await this.orderHelper.resolveCustomerData({
      ...createOrderDto,
      customer_id: customer_id ?? customerId,
    });

    // Récupérer les plats et vérifier leur disponibilité
    const dishesWithDetails = await this.orderHelper.getDishesWithDetails(
      items.map((item) => item.dish_id),
    );

    // Vérifier et appliquer le code promo s'il existe
    const promoDiscount = await this.orderHelper.applyPromoCode(
      orderData.code_promo,
    );

    // Calculer les montants et préparer les order items.
    // orderType : fait respecter available_order_types (plats + suppléments) côté serveur.
    const { orderItems, netAmount, totalDishes } =
      await this.orderHelper.calculateOrderDetails(items, dishesWithDetails, {
        orderType: orderData.type,
      });

    //Calculer la promotion et la création de l'utilisation de la promotion
    const promotion = await this.orderHelper.calculatePromotionPrice(
      promotion_id ?? '',
      {
        customer_id: customerData.customer_id,
        loyalty_level: customerData.loyalty_level,
      },
      totalDishes,
      orderItems.map((item) => ({
        dish_id: item.dish_id,
        quantity: item.quantity,
        price: item.dishPrice,
      })),
    );

    const discountPromotion = promotion ? promotion.discount_amount : 0;
    const offersDishes = promotion ? promotion.offers_dishes : [];
    const applicable = promotion ? promotion.applicable : false;

    // Calculer les frais de livraison selon la distance
    let delivery: {
      montant: number;
      zone: string;
      distance: number;
      service: DeliveryService;
      zone_id: string | null;
      original_montant?: number; // frais avant offre
      discount?: number; // remise offre sur le frais
    } | null = null;
    // Récupérer le restaurant le plus proche
    let restaurant: {
      name: string;
      id: string;
      longitude: number | null;
      latitude: number | null;
      schedule: Prisma.JsonValue;
      apikey: string | null;
    } | null = null;
    if (orderData.type == OrderType.DELIVERY) {
      restaurant = await this.orderHelper.getClosestRestaurant({
        restaurant_id: user_id ? restaurant_id : undefined,
        address,
      });
      // Vérifier l'adresse
      const addressData = await this.orderHelper.validateAddress(address ?? '');
      delivery = await this.deliveryFeeHelper.calculeFraisLivraison({
        lat: addressData.latitude,
        long: addressData.longitude,
        restaurant,
        channel: 'CALL_CENTER',
        orderAmount: netAmount,
        customerId: customerData.customer_id,
      });
    } else {
      restaurant = await this.orderHelper.getClosestRestaurant({
        restaurant_id: restaurant_id,
        address,
      });
    }

    // Modèle exclusion : tous les plats du panier doivent être vendus dans ce restaurant
    if (restaurant) {
      await this.orderHelper.assertDishesSoldInRestaurant(
        restaurant.id,
        items.map((item) => item.dish_id),
      );
    }

    // Montant frais de livraison (override admin préservé si delivery_fee fourni).
    const deliveryFee = delivery_fee || (delivery ? delivery?.montant : 0);
    // Frais PLEIN (avant offre) + remise, côté serveur → bilan fiable (call center inclus).
    // Si l'admin FORCE un frais (override), on ne lui attribue PAS la remise d'une offre
    // serveur : base = facturé, remise = 0 → invariant bilan (base = facturé + remise) préservé.
    const deliveryFeeBase = delivery_fee
      ? Number(deliveryFee)
      : (delivery ? (delivery.original_montant ?? delivery.montant) : Number(deliveryFee));
    const deliveryDiscount = delivery_fee ? 0 : (delivery?.discount ?? 0);

    // Vérifier le paiement
    const payment = await this.orderHelper.checkPayment(createOrderDto);

    // Calculer le montant de réduction des points de fidélité
    const loyaltyFee = await this.orderHelper.calculateLoyaltyFee(
      customerData.total_points,
      points ?? 0,
    );

    // Calcul de la remise
    const discount = netAmount * promoDiscount + loyaltyFee + discountPromotion;

    // Calcul du montant remisé
    const totalAfterDiscount = netAmount - discount;

    // calcul de la taxe
    const tax = user_id
      ? 0
      : await this.orderHelper.calculateTax(totalAfterDiscount);

    // Calcul du montant TTC
    const totalAmount = totalAfterDiscount + tax + deliveryFee;

    if (payment && payment.amount < totalAmount) {
      throw new BadRequestException(
        'Le montant du paiement est inférieur au montant de la commande',
      );
    }
    this.orderHelperV2.validateRestaurantChoice(restaurant.id, items.map((item) => item.dish_id))
    // Générer un numéro de commande unique
    const orderNumber = this.generateDataService.generateOrderReference();

    // Transaction pour garantir l'intégrité des données
    const order = await this.prisma.$transaction(async (prisma) => {
      // Créer la commande
      const createdOrder = await prisma.order.create({
        data: {
          ...orderData,
          fullname: customerData.fullname,
          phone: customerData.phone,
          email: customerData.email,
          ...(loyaltyFee && { points: points }),
          ...(applicable && { promotion: { connect: { id: promotion_id } } }),
          customer: {
            connect: {
              id: customerData.customer_id,
            },
          },
          ...(user_id && {
            user: {
              connect: {
                id: user_id,
              },
            },
          }),
          restaurant: {
            connect: {
              id: restaurant.id,
            },
          },
          reference: orderNumber,
          ...(payment && { paiements: { connect: { id: payment.id } } }),
          address: address ?? '',
          delivery_fee: delivery_fee ? delivery_fee : Number(deliveryFee),
          delivery_fee_base: Number(deliveryFeeBase),
          delivery_discount: Number(deliveryDiscount),
          // Override admin > auto-détection zone > fallback TURBO
          delivery_service: overrideDeliveryService ?? (delivery ? delivery.service : DeliveryService.TURBO),
          zone_id: delivery ? delivery.zone_id : undefined,
          tax: Number(tax),
          discount: Number(discount),
          net_amount: Number(netAmount),
          amount: Number(totalAmount),
          date: orderData.date ? new Date(orderData.date || '') : new Date(),
          time: orderData.time || '10:00',
          payment_method: user_id ? PaymentMethod.OFFLINE : PaymentMethod.ONLINE,
          status: user_id ? OrderStatus.ACCEPTED : OrderStatus.PENDING,
          paied_at: payment ? payment.created_at : null,
          paied: payment ? true : false,
          order_items: {
            create: [
              ...orderItems.map((item) => ({
                dish_id: item.dish_id,
                quantity: item.quantity,
                amount: item.amount,
                epice: item.epice,
                supplements: item.supplements,
              })),
              ...offersDishes.map((item) => ({
                dish_id: item.dish_id,
                quantity: item.quantity,
                amount: 0,
                supplements: [],
              })),
            ],
          },
          entity_status: EntityStatus.ACTIVE,
        },
        include: {
          order_items: {
            include: {
              dish: true,
            },
          },
          customer: {
            select: {
              id: true,
              first_name: true,
              last_name: true,
              phone: true,
              email: true,
              image: true,
            },
          },
          restaurant: true,
          paiements: true,
        },
      });

      return createdOrder;
    });

    if (user_id) {
      // Envoyer l'événement de création de commande
      this.orderEvent.orderCreatedEvent({
        order,
        payment_id: payment?.id,
        loyalty_level: customerData.loyalty_level,
        totalDishes,
        orderItems: orderItems.map((item) => ({
          dish_id: item.dish_id,
          quantity: item.quantity,
          price: item.dishPrice,
        })),
      });

      // Émettre l'événement de création de commande
      this.orderWebSocketService.emitOrderCreated(order);

      // WhatsApp tracking : uniquement si le client n'a PAS l'app
      this.sendTrackingWhatsAppIfNoApp(
        customerData.customer_id,
        customerData.fullname || order.phone || 'Client',
        order.phone || '',
        order.reference || '',
      ).catch((err) =>
        this.logger.error(`Erreur envoi WhatsApp tracking: ${err.message}`),
      );
    }

    // Commande backoffice créée directement ACCEPTED → comptabiliser l'usage
    // du code promo (elle ne passe pas par une transition de statut ultérieure).
    if (order.status === OrderStatus.ACCEPTED) {
      try {
        await this.promoCodeService.activateUsageForOrder(order);
      } catch (e) {
        this.logger.error(`Sync usage promo (create ACCEPTED) échoué pour ${order.id}: ${e?.message}`);
      }
    }

    return order;
  }

  /**
   * Envoie un WhatsApp de suivi si le client n'a pas l'app installée.
   * Détecte l'absence d'app via expo_push_token et onesignal_id.
   */
  private async sendTrackingWhatsAppIfNoApp(
    customerId: string,
    customerName: string,
    phone: string,
    orderReference: string,
  ) {
    const notifSettings = await this.prisma.notificationSetting.findUnique({
      where: { customer_id: customerId },
      select: { expo_push_token: true, onesignal_id: true },
    });

    // Si le client a un push token → il a l'app → on ne fait rien
    if (notifSettings?.expo_push_token || notifSettings?.onesignal_id) {
      this.logger.log(`Client ${customerId} a l'app, pas de WhatsApp tracking`);
      return;
    }

    // Pas d'app → envoyer le WhatsApp tracking
    this.logger.log(`Client ${customerId} n'a pas l'app, envoi WhatsApp tracking pour commande ${orderReference}`);
    await this.twilioService.sendTrackingOrder({
      phoneNumber: phone,
      customerName: customerName || 'Client',
      orderReference,
    });
  }

  /**
   * Met à jour le statut d'une commande
   */
  async updateStatus(
    id: string,
    status: OrderStatus,
    meta?: Record<string, any>,
  ) {
    const order = await this.findById(id);
    //Meta peut contenir estimated_delivery_time, estimated_preparation_time, deliveryDriverId, role
    // Valider la transition d'état.
    // Exception métier : un ADMIN peut ANNULER une commande QUEL QUE SOIT son état.
    // Les autres rôles (et les clients) restent soumis aux règles de l'app
    // (annulation uniquement depuis PENDING/ACCEPTED).
    const isAdmin = meta?.role === UserRole.ADMIN;
    this.orderHelper.validateStatusTransition(order.type, order.status, status, {
      allowCancelFromAnyStatus: isAdmin,
    });

    // Actions spécifiques selon le changement d'état
    await this.orderHelper.handleStatusSpecificActions(order, status, meta);

    const isDeleted = order.payment_method === PaymentMethod.ONLINE && order.status === OrderStatus.PENDING && status === OrderStatus.CANCELLED;
    // Mettre à jour le statut
    const updatedOrder = await this.prisma.order.update({
      where: { id: order.id },
      data: {
        estimated_delivery_time: this.orderHelper.calculateEstimatedTime(
          meta?.estimated_delivery_time ?? '',
        ),
        estimated_preparation_time: this.orderHelper.calculateEstimatedTime(
          meta?.estimated_preparation_time ?? '',
        ),
        ...(isDeleted && { entity_status: EntityStatus.DELETED, deleted_at: new Date() }),
        updated_at: new Date(),
        status,
        ...(status === OrderStatus.ACCEPTED && { accepted_at: new Date() }),
        ...(status === OrderStatus.IN_PROGRESS && { prepared_at: new Date() }),
        ...(status === OrderStatus.READY && { ready_at: new Date() }),
        ...(status === OrderStatus.PICKED_UP && { picked_up_at: new Date() }),
        ...(status === OrderStatus.COLLECTED && { collected_at: new Date() }),
        ...(status === OrderStatus.COMPLETED && { completed_at: new Date() }),
        ...(status === OrderStatus.CANCELLED && { cancelled_at: new Date(), cancelled_by: meta?.userId, cancelled_reason: meta?.reason || '' }),
        // Audit : dernier modificateur staff (meta.role n'est présent que sur le
        // flux backoffice ; côté client `/client/status` il est absent → on n'écrase pas).
        ...(meta?.role && meta?.userId ? { updated_by: meta.userId } : {}),
      },
      include: {
        order_items: {
          include: {
            dish: true,
          },
        },
        paiements: true,
        customer: {
          select: {
            id: true,
            first_name: true,
            last_name: true,
            phone: true,
            email: true,
            image: true,
            notification_settings: true,
          },
        },
        restaurant: true,
      },
    });

    // Cycle de vie de l'usage du code promo selon le statut :
    //  - → ACCEPTED (paiement confirmé) : comptabilise l'usage (usage_count++)
    //  - → CANCELLED : décompte l'usage (usage_count--)
    // Idempotent côté PromoCodeService ; isolé pour ne jamais casser la maj statut.
    try {
      if (status === OrderStatus.ACCEPTED && order.status !== OrderStatus.ACCEPTED) {
        await this.promoCodeService.activateUsageForOrder(updatedOrder);
      } else if (status === OrderStatus.CANCELLED) {
        await this.promoCodeService.deactivateUsageForOrder(order.id);
      }
    } catch (e) {
      this.logger.error(`Sync usage promo (statut ${status}) échoué pour ${order.id}: ${e?.message}`);
    }

    // Envoyer l'événement de mise à jour de statut de commande
    this.orderEvent.orderStatusUpdatedEvent({
      order: updatedOrder,
      expo_token: updatedOrder.customer.notification_settings?.expo_push_token,
      voucher: meta?._voucher ? {
        code: meta._voucher.code,
        initial_amount: meta._voucher.initial_amount,
        expires_at: meta._voucher.expires_at,
      } : null,
    });

    // Émettre l'événement de mise à jour de statut avec l'ancien statut
    this.orderWebSocketService.emitStatusUpdate(updatedOrder, order.status);

    return updatedOrder;
  }

  /**
   * Récupère une commande par son ID
   */
  async findById(id: string) {
    if (!id) {
      throw new BadRequestException("L'identifiant de la commande est requis");
    }

    const whereCondition = id.length > 10
      ? { id }
      : { reference: id };

    const order = await this.prisma.order.findFirst({
      where: {
        ...whereCondition,
        entity_status: { not: EntityStatus.DELETED },
      },
      include: {
        order_items: {
          include: {
            dish: true,
          },
        },
        paiements: true,
        customer: true,
        promotion: true,
        // Créateur de la commande (staff backoffice/caisse) — null si commande
        // passée par le client depuis l'app. Affiché côté admin uniquement.
        user: {
          select: { id: true, fullname: true, email: true, role: true },
        },
        restaurant: {
          select: {
            id: true,
            name: true,
            image: true,
            address: true,
            phone: true,
            email: true,
            latitude: true,
            longitude: true,
          },
        },
        // Suivi de livraison temps réel (app cliente) : présent uniquement pour
        // les commandes livrées par un livreur interne Chicken Nation (le
        // graphe Delivery → Course → Deliverer n'existe pas pour Turbo/PICKUP).
        // L'app cliente s'en sert pour rendre la carte type Uber Eats : statut
        // de la livraison, infos livreur (nom, photo, téléphone) et sa dernière
        // position GPS connue (point de départ avant les pings WS live).
        delivery: {
          select: {
            id: true,
            statut: true,
            sequence_order: true,
            in_route_at: true,
            arrived_at: true,
            delivered_at: true,
            // Code 4 chiffres que le client dicte au livreur à la remise pour
            // confirmer la réception (Delivery → DELIVERED). Exposé au client
            // (il en est le destinataire) ; le livreur, lui, ne le voit jamais
            // (son service `order-deliverer.service` a un select distinct).
            delivery_pin: true,
            course: {
              select: {
                id: true,
                statut: true,
                deliverer: {
                  select: {
                    id: true,
                    first_name: true,
                    last_name: true,
                    phone: true,
                    image: true,
                    type_vehicule: true,
                    last_location: true,
                    last_location_at: true,
                    last_heading_deg: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!order) {
      throw new NotFoundException(`Commande est introuvable`);
    }

    // Résolution du dernier modificateur staff (champ simple `updated_by`, pas
    // de relation Prisma — cf. schéma). Attaché sous `updated_by_user`.
    let updated_by_user: {
      id: string;
      fullname: string;
      email: string;
      role: string;
    } | null = null;
    if (order.updated_by) {
      updated_by_user = await this.prisma.user.findUnique({
        where: { id: order.updated_by },
        select: { id: true, fullname: true, email: true, role: true },
      });
    }

    return { ...order, updated_by_user };
  }

  /**
   * Récupère une commande par sa référence
   */
  async findByReference(reference: string) {
    if (!reference) {
      throw new BadRequestException('La référence de la commande est requis');
    }

    const order = await this.prisma.order.findFirst({
      where: {
        reference,
        entity_status: { not: EntityStatus.DELETED },
      },
      include: {
        order_items: {
          include: {
            dish: true,
          },
        },
        paiements: true,
        // notification_settings : nécessaire pour pousser « Commande confirmée »
        // au client au moment du paiement (cf. KkiapayOrderListenerService).
        customer: { include: { notification_settings: true } },
        restaurant: true,
      },
    });

    if (!order) {
      throw new NotFoundException(`Commande est introuvable`);
    }

    return order;
  }

  /**
   * Recherche et filtre les commandes
   */
  /**
   * Liste des commandes actives pour la page Opérations du backoffice.
   * Retourne (sans pagination, non tri sortBy) toutes les commandes d'un resto
   * dont le statut est en cours (ACCEPTED → IN_DELIVERY), avec la Course
   * et le Delivery associé si présents (pour grouper par course côté UI).
   */
  async findActiveForOperations(restaurantId?: string): Promise<Order[]> {
    const activeStatuses: OrderStatus[] = [
      OrderStatus.ACCEPTED,
      OrderStatus.IN_PROGRESS,
      OrderStatus.READY,
      OrderStatus.PICKED_UP,
      OrderStatus.COLLECTED,
    ];
    return this.prisma.order.findMany({
      where: {
        status: { in: activeStatuses },
        entity_status: { not: EntityStatus.DELETED },
        ...(restaurantId && { restaurant_id: restaurantId }),
      },
      include: {
        customer: {
          select: { id: true, first_name: true, last_name: true, phone: true, email: true, image: true },
        },
        restaurant: { select: { id: true, name: true, image: true, address: true } },
        order_items: { include: { dish: { select: { id: true, name: true, image: true, price: true } } } },
        paiements: true,
        delivery: {
          include: {
            course: {
              include: {
                deliverer: { select: { id: true, reference: true, first_name: true, last_name: true, phone: true, image: true } },
              },
            },
          },
        },
      },
      orderBy: { created_at: 'desc' },
    }) as unknown as Promise<Order[]>;
  }

  /**
   * Caissière encaisse le livreur pour une commande en espèce (payment_method = OFFLINE).
   * Cascade :
   *   - Order.paied = true + paied_at = now
   *   - Order.status → COMPLETED (si pas déjà) + completed_at
   *   - Émet order:updated pour rafraîchir en temps réel le backoffice Opérations
   *
   * @throws BadRequestException si l'order est déjà payée ou n'est pas en OFFLINE.
   */
  async markPaidCash(id: string, amount?: number) {
    const order = await this.prisma.order.findUnique({ where: { id } });
    if (!order) throw new NotFoundException('Commande introuvable');
    if (order.entity_status === EntityStatus.DELETED) {
      throw new BadRequestException('Commande supprimée');
    }
    if (order.paied) {
      throw new BadRequestException('Commande déjà payée');
    }
    if (order.payment_method !== PaymentMethod.OFFLINE) {
      throw new BadRequestException(
        'Cet endpoint n\'est utilisable que pour les commandes en espèce (OFFLINE)',
      );
    }

    const now = new Date();
    const isAlreadyCompleted = order.status === OrderStatus.COMPLETED;

    const updated = await this.prisma.order.update({
      where: { id },
      data: {
        paied: true,
        paied_at: now,
        ...(!isAlreadyCompleted && {
          status: OrderStatus.COMPLETED,
          completed_at: now,
        }),
      },
      include: {
        customer: true,
        restaurant: true,
        order_items: { include: { dish: true } },
      },
    });

    // Log d'audit : si un montant est fourni et diffère du montant attendu
    if (amount !== undefined && Math.abs(amount - updated.amount) > 0.01) {
      this.logger.warn(
        `Order ${updated.reference} : montant reçu ${amount} ≠ montant dû ${updated.amount}`,
      );
    }

    // Encaissement cash confirmé → comptabiliser l'usage du code promo
    // (cas où la commande OFFLINE n'est pas passée par une transition ACCEPTED).
    // Idempotent ; isolé.
    try {
      await this.promoCodeService.activateUsageForOrder(updated);
    } catch (e) {
      this.logger.error(`Sync usage promo (markPaidCash) échoué pour ${updated.id}: ${e?.message}`);
    }

    // Event WebSocket pour que le drawer/cards se rafraîchissent côté backoffice
    this.orderWebSocketService.emitOrderUpdated(updated as Order);

    return updated;
  }

  async findAll(filters: QueryOrderDto, user?: User): Promise<QueryResponseDto<Order>> {
    const {
      reference,
      status,
      type,
      customerId,
      restaurantId,
      minAmount,
      maxAmount,
      page = 1,
      limit = 10,
      pagination = true,
      sortBy = 'created_at',
      sortOrder = 'desc',
      startDate = startOfMonth(new Date()),
      endDate = new Date(),
    } = filters;

    const where: Prisma.OrderWhereInput = {
      entity_status: { not: EntityStatus.DELETED },
      ...(status && { status }),
      ...(type && { type }),
      ...(customerId && { customer_id: customerId }),
      ...(minAmount && { amount: { gte: minAmount } }),
      ...(maxAmount && { amount: { lte: maxAmount } }),
      ...(restaurantId && { restaurant_id: restaurantId }),
      ...(reference && {
        reference: {
          contains: reference,
          mode: 'insensitive',
        },
      }),
    };

    if (filters.auto === undefined) {
      where.OR = [
        { auto: false },
        {
          AND: [
            { auto: true },
            { status: { not: OrderStatus.PENDING } } // N'affiche pas les brouillons de l'appli
          ]
        }
      ];
    }
    // Si on filtre explicitement pour l'appli (ex: stats spécifiques)
    else if (filters.auto === true) {
      where.auto = true;
      where.status = { not: OrderStatus.PENDING }; // Le call center ne voit que les acceptées
    }
    // Si on filtre explicitement pour le Call Center
    else if (filters.auto === false) {
      where.auto = false;
    }

    if (startDate && endDate) {
      where.created_at = {
        gte: startDate,
        lte: new Date(new Date(endDate).setHours(23, 59, 59, 999)),
      };
    }

    // 🔒 Visibilité PENDING : seul l'ADMIN voit les commandes « en attente ».
    // Pour tout autre rôle, on exclut PENDING via un AND de premier niveau : il se
    // compose avec le filtre `status` explicite (un non-admin qui demande PENDING
    // obtient un résultat vide) ET avec le bloc `auto` ci-dessus. Une commande payée
    // en ligne passe TOUJOURS ACCEPTED → on ne masque jamais une commande payée.
    if (user?.role !== UserRole.ADMIN) {
      where.AND = [
        ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
        { status: { not: OrderStatus.PENDING } },
      ];
    }

    const [orders, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        include: {
          order_items: {
            include: {
              dish: true,
            },
          },
          paiements: true,
          customer: {
            select: {
              id: true,
              first_name: true,
              last_name: true,
              phone: true,
              email: true,
              image: true,
            },
          },
          restaurant: {
            select: {
              id: true,
              name: true,
              image: true,
              address: true,
              phone: true,
              email: true,
              latitude: true,
              longitude: true,
            },
          },
        },
        ...(pagination
          ? {
            skip: (page - 1) * limit,
            take: limit,
          }
          : {}),
        orderBy: {
          [sortBy]: sortOrder,
        },
      }),
      this.prisma.order.count({ where }),
    ]);

    return {
      data: orders,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Recherche et filtre les commandes d'un client
   */
  async findAllByCustomer(
    req: Request,
    filters: QueryOrderCustomerDto,
  ): Promise<QueryResponseDto<Order>> {
    const {
      status: statusFilter,
      startDate,
      endDate,
      minAmount,
      maxAmount,
      page = 1,
      limit = 10,
    } = filters;

    const customerId = (req.user as Customer).id;
    const where: Prisma.OrderWhereInput = {
      customer_id: customerId,
      entity_status: { not: EntityStatus.DELETED },

      ...(statusFilter && {
        ...(statusFilter == 'processing'
          ? {
            status: {
              in: [
                OrderStatus.PENDING,
                OrderStatus.ACCEPTED,
                OrderStatus.IN_PROGRESS,
                OrderStatus.READY,
                OrderStatus.PICKED_UP,
              ],
            },
          }
          : statusFilter == 'completed'
            ? {
              status: {
                in: [OrderStatus.COLLECTED, OrderStatus.COMPLETED],
              },
            }
            : statusFilter == 'cancelled'
              ? { status: OrderStatus.CANCELLED }
              : {}),
      }),

      ...(startDate &&
        endDate && {
        created_at: {
          gte: new Date(startDate),
          lte: new Date(endDate),
        },
      }),

      ...(minAmount && { amount: { gte: minAmount } }),
      ...(maxAmount && { amount: { lte: maxAmount } }),
    };

    const [orders, total] = await Promise.all([
      this.prisma.order.findMany({
        where,
        include: {
          order_items: {
            include: {
              dish: true,
            },
          },
          paiements: true,
          customer: {
            select: {
              id: true,
              first_name: true,
              last_name: true,
              phone: true,
              email: true,
              image: true,
            },
          },
          restaurant: {
            select: {
              id: true,
              name: true,
              image: true,
              address: true,
              phone: true,
              email: true,
              latitude: true,
              longitude: true,
            },
          },
        },
        skip: (page - 1) * limit,
        take: limit,
        orderBy: {
          created_at: 'desc',
        },
      }),
      this.prisma.order.count({ where }),
    ]);

    return {
      data: orders,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Met à jour une commande client
   */
  async updateClient(id: string, orderUpdatedDto: OrderUpdatedDto) {
    const { delivery_fee, date, status, ...rest } = orderUpdatedDto;
    const order = await this.findById(id);

    // 1. Gestion de la Date (Reconstruction identique)
    let finalDate: Date;
    if (date && typeof date === 'string') {
      finalDate = new Date(date);
    } else {
      finalDate = new Date(order.date!);
      if (order.time) {
        const [hours, minutes] = order.time.split(':').map(Number);
        finalDate.setHours(hours, minutes, 0, 0);
      }
    }

    let statusUpdateData = {};
    if (status === OrderStatus.ACCEPTED) {
      if (order.status !== OrderStatus.PENDING) {
        throw new ConflictException("Cette commande ne peut plus être confirmée.");
      }
      statusUpdateData = {
        status: OrderStatus.ACCEPTED,
        accepted_at: new Date(),
      };
    }

    const updatedOrder = await this.prisma.order.update({
      where: { id: order.id },
      data: {
        ...rest,
        ...statusUpdateData,
        date: finalDate,
        time: finalDate.toISOString().split('T')[1].substring(0, 5),
        updated_at: new Date(),
      },
      include: {
        order_items: { include: { dish: true } },
        paiements: true,
        customer: true,
      },
    });

    this.orderEvent.orderUpdatedEvent(updatedOrder, orderUpdatedDto);
    this.orderWebSocketService.emitOrderUpdated(updatedOrder);

    // 🔊 Signal spécifique pour la tablette du restaurant
    if (status === OrderStatus.ACCEPTED) {
      this.orderWebSocketService.emitStatusUpdate(updatedOrder, order.status);
      // Commande confirmée → comptabiliser l'usage du code promo.
      try {
        await this.promoCodeService.activateUsageForOrder(updatedOrder);
      } catch (e) {
        this.logger.error(`Sync usage promo (updateClient ACCEPTED) échoué pour ${order.id}: ${e?.message}`);
      }
    }

    return updatedOrder;
  }
  /**
   * Met à jour une commande.
   *
   * @param options.skipStatusCheck  Si `true`, la garde "statut modifiable" est
   *   désactivée (réservé à l'admin : un admin peut corriger une commande
   *   COMPLETED / COLLECTED / CANCELLED pour rectifier une erreur de saisie,
   *   un audit comptable, etc.). Le controller met ce flag à `true` UNIQUEMENT
   *   si le user JWT a le rôle ADMIN.
   */
  async update(
    id: string,
    updateOrderDto: UpdateOrderDto,
    options: { skipStatusCheck?: boolean; userId?: string } = {},
  ) {
    const order = await this.findById(id);
    // Extraire les champs qui ne sont pas des colonnes directes de la table Order
    const {
      paiement_id,
      delivery_fee,
      items,
      customer_id,
      restaurant_id,
      user_id,
      auto,
      points,
      promotion_id,
      code_promo,
      ...rest
    } = updateOrderDto;

    // Vérifier que la commande peut être modifiée (admin peut bypasser)
    if (
      !options.skipStatusCheck &&
      order.status !== OrderStatus.PENDING &&
      order.status !== OrderStatus.ACCEPTED &&
      order.status !== OrderStatus.IN_PROGRESS &&
      order.status !== OrderStatus.READY
    ) {
      throw new ConflictException(
        'Seules les commandes en attente, acceptées, en préparation ou prêtes peuvent être modifiées',
      );
    }

    // Si des items sont fournis, recalculer les order_items
    let orderItemsData: {
      dish_id: string;
      quantity: number;
      amount: number;
      epice: boolean;
      supplements: any[];
    }[] | null = null;
    let newNetAmount: number | null = null;

    if (items && items.length > 0) {
      // Récupérer les plats correspondants
      const dishIds = items.map((item) => item.dish_id);
      const dishes = await this.prisma.dish.findMany({
        where: {
          id: { in: dishIds },
          entity_status: EntityStatus.ACTIVE,
        },
      });

      // Calculer les détails de la commande.
      // skipExclusionCheck : on édite une commande existante — un supplément
      // acheté légitimement avant d'être exclu du plat doit pouvoir être conservé.
      const { orderItems, netAmount } =
        await this.orderHelper.calculateOrderDetails(items, dishes, {
          skipExclusionCheck: true,
        });

      orderItemsData = orderItems.map((item) => ({
        dish_id: item.dish_id,
        quantity: item.quantity,
        amount: item.amount,
        epice: item.epice,
        supplements: item.supplements,
      }));
      newNetAmount = netAmount;
    }

    // Si le type n'est pas DELIVERY, forcer les frais de livraison à 0
    const isDelivery = (rest.type ?? order.type) === OrderType.DELIVERY;
    const finalDeliveryFee = isDelivery ? (delivery_fee ?? order.delivery_fee ?? 0) : 0;

    // Construire les données de mise à jour (uniquement les champs Prisma valides)
    const updateData: any = {
      ...rest,
      delivery_fee: finalDeliveryFee,
      estimated_delivery_time: this.orderHelper.calculateEstimatedTime(
        rest?.estimated_delivery_time ?? '',
      ),
      estimated_preparation_time: this.orderHelper.calculateEstimatedTime(
        rest?.estimated_preparation_time ?? '',
      ),
      updated_at: new Date(),
      // Audit : staff ayant fait cette modification (transmis par le contrôleur).
      ...(options.userId ? { updated_by: options.userId } : {}),
    };

    // Ajouter les relations si fournies
    if (customer_id) updateData.customer = { connect: { id: customer_id } };
    if (restaurant_id) updateData.restaurant = { connect: { id: restaurant_id } };
    if (user_id) updateData.user = { connect: { id: user_id } };
    if (auto !== undefined) updateData.auto = auto;

    // Si les items ont été recalculés, mettre à jour le montant et les order_items
    if (orderItemsData && newNetAmount !== null) {
      // Recalculer le montant total
      const tax = order.tax ?? 0;
      const discount = order.discount ?? 0;
      const totalAfterDiscount = newNetAmount - discount;
      const totalAmount = totalAfterDiscount + tax + finalDeliveryFee;

      updateData.net_amount = Number(newNetAmount);
      updateData.amount = Number(totalAmount);

      // Supprimer les anciens items et créer les nouveaux
      updateData.order_items = {
        deleteMany: {},
        create: orderItemsData,
      };
    }

    let updatedOrder = await this.prisma.order.update({
      where: { id: order.id },
      data: updateData,
      include: {
        order_items: {
          include: {
            dish: true,
          },
        },
        paiements: true,
        customer: true,
      },
    });

    // Si le montant a changé (recalcul des items, frais de livraison, etc.),
    // re-synchroniser le flag `paied` selon la somme des paiements SUCCESS :
    //  - amount augmenté > total perçu → paied = false (reste dû à encaisser)
    //  - amount baissé sous le total perçu → paied = true (trop perçu existe en BD)
    // Sans ce recompute, la commande modifiée garde son ancien `paied` et le drawer
    // affiche un mauvais solde.
    if (updateData.amount !== undefined) {
      updatedOrder = await this.recomputeOrderPaiedFlag(updatedOrder.id);
    }

    // Envoyer l'événement de mise à jour de statut de commande
    this.orderEvent.orderUpdatedEvent(updatedOrder, updateOrderDto);

    // Émettre via WebSocket
    this.orderWebSocketService.emitOrderUpdated(updatedOrder);
    return updatedOrder;
  }

  /**
   * Re-synchronise le flag `paied` d'une commande selon la somme actuelle de ses
   * paiements SUCCESS. Utilisé après une modification d'amount (update commande)
   * ou un changement de paiement (update/delete paiement).
   *
   * Règle : paied = (sum(SUCCESS paiements) >= order.amount)
   * Si la commande devient payée et qu'elle n'avait pas de paied_at, on le pose
   * sur le paiement SUCCESS le plus récent. Si elle redevient non-payée, on remet
   * paied_at à null.
   */
  async recomputeOrderPaiedFlag(orderId: string) {
    const fresh = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        paiements: { where: { status: PaiementStatus.SUCCESS } },
      },
    });
    if (!fresh) {
      throw new NotFoundException('Commande introuvable');
    }
    const totalPaid = fresh.paiements.reduce(
      (sum, p) => sum + (p.total ?? p.amount ?? 0),
      0,
    );
    // Tolérance d'arrondi taxe app/back (= PAYMENT_AMOUNT_TOLERANCE, cf. paiements.service)
    const shouldBePaied = totalPaid >= fresh.amount - 50;
    if (shouldBePaied === fresh.paied) {
      // Rien à changer — on renvoie tout de même la commande détaillée pour
      // que l'appelant ait un objet à jour.
      const refreshed = await this.prisma.order.findUnique({
        where: { id: orderId },
        include: {
          order_items: { include: { dish: true } },
          paiements: true,
          customer: true,
        },
      });
      if (!refreshed) throw new NotFoundException('Commande introuvable');
      return refreshed;
    }
    const mostRecentSuccess = fresh.paiements.reduce<Date | null>(
      (latest, p) => {
        const at = p.created_at ?? null;
        if (!at) return latest;
        return !latest || at > latest ? at : latest;
      },
      null,
    );
    return this.prisma.order.update({
      where: { id: orderId },
      data: {
        paied: shouldBePaied,
        paied_at: shouldBePaied ? (fresh.paied_at ?? mostRecentSuccess ?? new Date()) : null,
      },
      include: {
        order_items: { include: { dish: true } },
        paiements: true,
        customer: true,
      },
    });
  }

  /**
   * Supprime une commande (soft delete)
   */
  async remove(id: string) {
    const order = await this.findById(id);

    // Vérifier que la commande peut être supprimée
    if (order.paied === true) {
      throw new ConflictException(
        'Les commandes payées ne peuvent pas être supprimées',
      );
    }

    const orderDeleted = await this.prisma.order.update({
      where: { id: order.id },
      include: {
        customer: true,
      },
      data: { entity_status: EntityStatus.DELETED },
    });

    // Envoyer l'événement de suppression de commande
    this.orderEvent.orderDeletedEvent(order);

    // Émettre via WebSocket
    this.orderWebSocketService.emitOrderDeleted(order);

    return orderDeleted;
  }

  /**
   * Calcule les statistiques des commandes pour un tableau de bord
   */
  async getOrderStatistics(filters?: QueryOrderDto) {
    // Construire la clause where à partir des filtres
    const where: Prisma.OrderWhereInput =
      this.orderHelper.buildWhereClause(filters);

    // Exécuter les requêtes en parallèle pour les performances
    const [
      totalOrders,
      totalAmount,
      ordersByStatus,
      ordersByType,
      recentOrders,
      averageOrderValue,
      topDishes,
    ] = await Promise.all([
      // Nombre total de commandes
      this.prisma.order.count({ where: { paied: true, ...where } }),

      // Montant total des ventes
      this.prisma.order.aggregate({
        where: { paied: true, ...where },
        _sum: { amount: true },
      }),

      // Commandes par statut
      this.prisma.order.groupBy({
        by: ['status'],
        where: { paied: true, ...where },
        _count: true,
      }),

      // Commandes par type
      this.prisma.order.groupBy({
        by: ['type'],
        where: { paied: true, ...where },
        _count: true,
      }),

      // Commandes récentes
      this.prisma.order.findMany({
        where: { paied: true, ...where },
        orderBy: { created_at: 'desc' },
        take: 5,
        include: {
          customer: true,
          order_items: {
            include: { dish: true },
          },
        },
      }),

      // Valeur moyenne des commandes
      this.prisma.order.aggregate({
        where: { paied: true, ...where },
        _avg: { amount: true },
      }),

      // Plats les plus commandés
      this.prisma.orderItem
        .groupBy({
          by: ['dish_id'],
          where: {
            order: { paied: true, ...where },
          },
          _sum: {
            quantity: true,
          },
          orderBy: {
            _sum: {
              quantity: 'desc',
            },
          },
          take: 10,
        })
        .then(async (items) => {
          const dishIds = items.map((item) => item.dish_id);
          const dishes = await this.prisma.dish.findMany({
            where: { id: { in: dishIds } },
          });

          return items.map((item) => ({
            ...item,
            dish: dishes.find((d) => d.id === item.dish_id),
          }));
        }),
    ]);

    return {
      totalOrders,
      totalAmount: totalAmount._sum.amount || 0,
      ordersByStatus,
      ordersByType,
      recentOrders,
      averageOrderValue: averageOrderValue._avg.amount || 0,
      topDishes,
    };
  }

  async exportOrderReportToPDF(filters: QueryOrderDto) {
    const {
      startDate,
      endDate,
      sortBy = 'created_at',
      sortOrder = 'desc',
    } = filters;

    const where: Prisma.OrderWhereInput = {
      entity_status: { not: EntityStatus.DELETED },
      OR: [
        {
          AND: [{ paied: false }, { auto: false }],
        },
        {
          paied: true,
        },
      ],
    };

    if (startDate && endDate) {
      where.created_at = {
        gte: startDate,
        lte: new Date(new Date(endDate).setHours(23, 59, 59, 999)),
      };
    }

    const orders = await this.prisma.order.findMany({
      where,
      include: {
        order_items: {
          include: {
            dish: true,
          },
        },
        paiements: true,
        customer: {
          select: {
            id: true,
            first_name: true,
            last_name: true,
            phone: true,
            email: true,
            image: true,
          },
        },
        restaurant: {
          select: {
            id: true,
            name: true,
            image: true,
            address: true,
            phone: true,
            email: true,
            latitude: true,
            longitude: true,
          },
        },
        user: {
          select: {
            id: true,
            fullname: true,
            email: true,
            phone: true,
            image: true,
          },
        },
      },
      orderBy: {
        [sortBy]: sortOrder,
      },
    });

    // TODO:GENERATE PDF
    // const pdf = await this.pdfService.generatePdf(orders);
    // return pdf;
    return orders;
  }
  async exportOrderReportToExcel(filters: QueryOrderDto) {
    const {
      restaurantId,
      startDate,
      endDate,
      status,
      sortBy = 'created_at',
      sortOrder = 'desc',
    } = filters;

    const where: Prisma.OrderWhereInput = {
      entity_status: { not: EntityStatus.DELETED },
    };

    if (restaurantId) {
      where.restaurant_id = restaurantId;
    }

    if (status) {
      where.status = status;
    }

    if (startDate && endDate) {
      where.created_at = {
        gte: startDate,
        lte: new Date(new Date(endDate).setHours(23, 59, 59, 999)),
      };
    }

    if (filters.auto === undefined) {
      where.OR = [
        { auto: false }, // Voit tout du Call Center
        {
          AND: [
            { auto: true },
            { status: { not: OrderStatus.PENDING } } // N'affiche pas les brouillons de l'appli
          ]
        }
      ];
    } else if (filters.auto === true) {
      where.auto = true;
      where.status = { not: OrderStatus.PENDING };
    } else if (filters.auto === false) {
      where.auto = false;
    }

    const orders = await this.prisma.order.findMany({
      where,
      include: {
        order_items: {
          include: {
            dish: true,
          },
        },
        paiements: true,
        customer: {
          select: {
            id: true,
            first_name: true,
            last_name: true,
            phone: true,
            email: true,
            image: true,
          },
        },
        restaurant: {
          select: {
            id: true,
            name: true,
            image: true,
            address: true,
            phone: true,
            email: true,
            latitude: true,
            longitude: true,
          },
        },
        user: {
          select: {
            id: true,
            fullname: true,
            email: true,
            phone: true,
            image: true,
          },
        },
      },
      orderBy: {
        [sortBy]: sortOrder,
      },
    });

    // Génération du fichier Excel
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Rapport des commandes');

    // En-têtes
    worksheet.columns = [
      { header: 'Référence', key: 'reference', width: 20 },
      { header: 'Total TTC (FCFA)', key: 'amount', width: 18 },
      { header: 'Sous-total (FCFA)', key: 'net_amount', width: 18 },
      { header: 'Montant net (FCFA)', key: 'montant_net', width: 20 },
      { header: 'Frais de livraison (FCFA)', key: 'delivery_fee', width: 25 },
      { header: 'Taxe (FCFA)', key: 'tax', width: 15 },
      { header: 'Remise (FCFA)', key: 'discount', width: 15 },
      { header: 'Montant payé (FCFA)', key: 'paid_amount', width: 20 },
      { header: 'Date', key: 'date', width: 15 },
      { header: 'Client', key: 'client', width: 25 },
      { header: 'Contact', key: 'contact', width: 15 },
      { header: 'Email', key: 'email', width: 30 },
      { header: 'Restaurant', key: 'restaurant', width: 25 },
      { header: 'Source', key: 'source', width: 12 },
      { header: 'Mode de paiement', key: 'payment_mode', width: 25 },
    ];

    // Style de l'en-tête
    worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF3B82F6' },
    };
    worksheet.getRow(1).alignment = {
      vertical: 'middle',
      horizontal: 'center',
    };

    // Variables pour les totaux
    let totalTTC = 0;
    let totalSousTotal = 0;
    let totalMontantNet = 0;
    let totalFraisLivraison = 0;
    let totalTaxe = 0;
    let totalRemise = 0;
    let totalPaye = 0;

    // Données
    orders.forEach((order) => {
      const montantNet = order.net_amount - order.discount;
      // Montant réellement payé par le client = Σ paiements SUCCESS (cohérent avec
      // le « Réellement perçu » du drawer). Les frais KKiaPay sont exclus.
      const montantPaye = (order.paiements || [])
        .filter((p) => p.status === 'SUCCESS')
        .reduce((s, p) => s + (p.amount || 0), 0);
      const clientName =
        [order.customer.first_name, order.customer.last_name]
          .filter(Boolean)
          .join(' ') || 'N/A';

      const paymentMethods = order.paiements.length > 0
        ? Array.from(new Set(order.paiements.map(p => p.source || p.mode))).join(', ')
        : 'N/A';

      worksheet.addRow({
        reference: order.reference,
        amount: order.amount,
        net_amount: order.net_amount,
        montant_net: montantNet,
        delivery_fee: order.delivery_fee,
        tax: order.tax,
        discount: order.discount,
        paid_amount: montantPaye,
        date: format(new Date(order.created_at), 'dd/MM/yyyy HH:mm', { locale: fr }),
        client: clientName,
        contact: order.customer.phone || 'N/A',
        email: order.customer.email || 'N/A',
        restaurant: order.restaurant.name,
        source: order.auto ? 'Appli' : 'Téléphone',
        payment_mode: paymentMethods.toLowerCase(),
      });

      // Cumul des totaux
      totalTTC += order.amount;
      totalSousTotal += order.net_amount;
      totalMontantNet += montantNet;
      totalFraisLivraison += order.delivery_fee;
      totalTaxe += order.tax;
      totalRemise += order.discount;
      totalPaye += montantPaye;
    });

    // Formatage des colonnes monétaires (nombres avec séparateur de milliers)
    const currencyColumns = [
      'amount',
      'net_amount',
      'montant_net',
      'delivery_fee',
      'tax',
      'discount',
      'paid_amount',
    ];
    currencyColumns.forEach((col) => {
      const column = worksheet.getColumn(col);
      column.numFmt = '#,##0';
      column.alignment = { horizontal: 'right' };
    });

    // Ligne de totaux
    const totalRow = worksheet.addRow({
      reference: 'TOTAL',
      amount: totalTTC,
      net_amount: totalSousTotal,
      montant_net: totalMontantNet,
      delivery_fee: totalFraisLivraison,
      tax: totalTaxe,
      discount: totalRemise,
      paid_amount: totalPaye,
      date: '',
      client: '',
      contact: '',
      email: '',
      restaurant: '',
      source: '',
      payment_mode: '',
    });

    // Style de la ligne de totaux
    totalRow.font = { bold: true };
    totalRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE5E7EB' },
    };

    // Bordures pour toutes les cellules
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: true }, (cell) => {
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFD1D5DB' } },
          left: { style: 'thin', color: { argb: 'FFD1D5DB' } },
          bottom: { style: 'thin', color: { argb: 'FFD1D5DB' } },
          right: { style: 'thin', color: { argb: 'FFD1D5DB' } },
        };
      });
    });

    // Alternance de couleurs pour les lignes (sauf en-tête et total)
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber > 1 && rowNumber < worksheet.rowCount) {
        if (rowNumber % 2 === 0) {
          row.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFF9FAFB' },
          };
        }
      }
    });

    const buffer = await workbook.xlsx.writeBuffer();

    return {
      buffer,
      filename: `rapport-commandes-${new Date().toISOString().split('T')[0]}.xlsx`,
    };
  }


  /**
   * Export Excel des LIVRAISONS — pour le rapprochement avec Turbo (le prestataire).
   * Une ligne par commande DELIVERY : frais plein / remise offre / facturé + infos
   * livraison (service, zone, origine, destination, statut, livré le).
   */
  async exportDeliveriesToExcel(filters: QueryOrderDto, user?: User) {
    const {
      restaurantId,
      startDate,
      endDate,
      status,
      sortBy = 'created_at',
      sortOrder = 'desc',
    } = filters;

    const where: Prisma.OrderWhereInput = {
      entity_status: { not: EntityStatus.DELETED },
      type: OrderType.DELIVERY,
    };
    if (restaurantId) where.restaurant_id = restaurantId;
    if (status) where.status = status;
    if (startDate && endDate) {
      where.created_at = {
        gte: startDate,
        lte: new Date(new Date(endDate).setHours(23, 59, 59, 999)),
      };
    }
    // PENDING (brouillons app non payés) réservé à l'admin — cohérent avec findAll.
    if (user?.role !== UserRole.ADMIN) {
      where.AND = [
        ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
        { status: { not: OrderStatus.PENDING } },
      ];
    }

    const orders = await this.prisma.order.findMany({
      where,
      include: {
        customer: { select: { first_name: true, last_name: true, phone: true } },
        restaurant: { select: { name: true } },
        delivery: {
          select: { statut: true, delivered_at: true, in_route_at: true, failure_reason: true },
        },
      },
      orderBy: { [sortBy]: sortOrder },
    });

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Livraisons');

    worksheet.columns = [
      { header: 'Date', key: 'date', width: 18 },
      { header: 'Commande', key: 'reference', width: 20 },
      { header: 'Frais de base (FCFA)', key: 'fee_base', width: 20 },
      { header: 'Remise offre (FCFA)', key: 'fee_discount', width: 20 },
      { header: 'Frais facturé (FCFA)', key: 'fee_billed', width: 20 },
      { header: 'Service', key: 'service', width: 14 },
      { header: 'Zone', key: 'zone', width: 18 },
      { header: 'Restaurant', key: 'restaurant', width: 24 },
      { header: 'Destination', key: 'destination', width: 32 },
      { header: 'Client', key: 'client', width: 22 },
      { header: 'Téléphone', key: 'phone', width: 16 },
      { header: 'Statut livraison', key: 'delivery_status', width: 18 },
      { header: 'Livré le', key: 'delivered_at', width: 18 },
      { header: 'Source', key: 'source', width: 12 },
      { header: 'Payée', key: 'paid', width: 10 },
    ];

    worksheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF3B82F6' },
    };
    worksheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };

    let totalBase = 0;
    let totalDiscount = 0;
    let totalBilled = 0;

    orders.forEach((order) => {
      // Order.address = JSON { title, address, street?, city?, longitude, latitude, note }
      const addr = (order.address as any) || {};
      const destination =
        [addr.address, addr.note].filter(Boolean).join(' — ') || addr.title || 'N/A';
      const clientName =
        [order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(' ') || 'N/A';
      const base = order.delivery_fee_base ?? 0;
      const discount = order.delivery_discount ?? 0;
      const billed = order.delivery_fee ?? 0;

      worksheet.addRow({
        date: format(new Date(order.created_at), 'dd/MM/yyyy HH:mm', { locale: fr }),
        reference: order.reference,
        fee_base: base,
        fee_discount: discount,
        fee_billed: billed,
        service: order.delivery_service,
        zone: order.zone_id || '—',
        restaurant: order.restaurant?.name || 'N/A',
        destination,
        client: clientName,
        phone: order.customer?.phone || 'N/A',
        delivery_status: order.delivery?.statut || order.status,
        delivered_at: order.delivery?.delivered_at
          ? format(new Date(order.delivery.delivered_at), 'dd/MM/yyyy HH:mm', { locale: fr })
          : '',
        source: order.auto ? 'Appli' : 'Téléphone',
        paid: order.paied ? 'Oui' : 'Non',
      });

      totalBase += base;
      totalDiscount += discount;
      totalBilled += billed;
    });

    ['fee_base', 'fee_discount', 'fee_billed'].forEach((col) => {
      const column = worksheet.getColumn(col);
      column.numFmt = '#,##0';
      column.alignment = { horizontal: 'right' };
    });

    const totalRow = worksheet.addRow({
      date: '',
      reference: 'TOTAL',
      fee_base: totalBase,
      fee_discount: totalDiscount,
      fee_billed: totalBilled,
      service: '',
      zone: '',
      restaurant: '',
      destination: '',
      client: '',
      phone: '',
      delivery_status: '',
      delivered_at: '',
      source: '',
      paid: '',
    });
    totalRow.font = { bold: true };
    totalRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE5E7EB' },
    };

    worksheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: true }, (cell) => {
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFD1D5DB' } },
          left: { style: 'thin', color: { argb: 'FFD1D5DB' } },
          bottom: { style: 'thin', color: { argb: 'FFD1D5DB' } },
          right: { style: 'thin', color: { argb: 'FFD1D5DB' } },
        };
      });
    });
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber > 1 && rowNumber < worksheet.rowCount && rowNumber % 2 === 0) {
        row.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFF9FAFB' },
        };
      }
    });

    const buffer = await workbook.xlsx.writeBuffer();
    return {
      buffer,
      filename: `livraisons-turbo-${new Date().toISOString().split('T')[0]}.xlsx`,
    };
  }


  /**
   * Export Excel pivot : Date × Restaurants → nb livraisons
   */
  async exportDeliveryPivotToExcel(filters: QueryOrderDto) {
    const { restaurantId, startDate, endDate, status } = filters;

    const where: Prisma.OrderWhereInput = {
      entity_status: { not: EntityStatus.DELETED },
      type: OrderType.DELIVERY,
    };

    if (restaurantId) {
      where.restaurant_id = restaurantId;
    }

    if (status) {
      where.status = status;
    }

    if (startDate && endDate) {
      where.created_at = {
        gte: startDate,
        lte: new Date(new Date(endDate).setHours(23, 59, 59, 999)),
      };
    }

    if (filters.auto === undefined) {
      where.OR = [
        { auto: false },
        {
          AND: [
            { auto: true },
            { status: { not: OrderStatus.PENDING } },
          ],
        },
      ];
    } else if (filters.auto === true) {
      where.auto = true;
      where.status = { not: OrderStatus.PENDING };
    } else if (filters.auto === false) {
      where.auto = false;
    }

    const orders = await this.prisma.order.findMany({
      where,
      select: {
        created_at: true,
        restaurant: { select: { id: true, name: true } },
      },
      orderBy: { created_at: 'asc' },
    });

    // Collecter tous les restaurants uniques (triés par nom)
    const restaurantMap = new Map<string, string>();
    orders.forEach((o) => restaurantMap.set(o.restaurant.id, o.restaurant.name));
    const restaurants = Array.from(restaurantMap.entries()).sort((a, b) =>
      a[1].localeCompare(b[1]),
    );

    // Pivoter : date → { restaurantId → count }
    const pivotMap = new Map<string, Map<string, number>>();
    orders.forEach((o) => {
      const dateKey = format(new Date(o.created_at), 'dd/MM/yyyy');
      if (!pivotMap.has(dateKey)) pivotMap.set(dateKey, new Map());
      const dayMap = pivotMap.get(dateKey)!;
      dayMap.set(o.restaurant.id, (dayMap.get(o.restaurant.id) || 0) + 1);
    });

    // Générer le fichier Excel
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Livraisons par restaurant');

    // Colonnes dynamiques
    worksheet.columns = [
      { header: 'Date', key: 'date', width: 14 },
      ...restaurants.map(([id, name]) => ({
        header: name,
        key: id,
        width: Math.max(name.length + 2, 12),
      })),
      { header: 'TOTAL', key: 'total', width: 12 },
    ];

    // Style de l'en-tête
    const headerRow = worksheet.getRow(1);
    headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    headerRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFF17922' },
    };
    headerRow.alignment = { vertical: 'middle', horizontal: 'center' };

    // Totaux par restaurant (pour la ligne de total en bas)
    const restaurantTotals = new Map<string, number>();
    let grandTotal = 0;

    // Données - une ligne par date
    const sortedDates = Array.from(pivotMap.keys());
    sortedDates.forEach((dateKey) => {
      const dayMap = pivotMap.get(dateKey)!;
      const rowData: Record<string, any> = { date: dateKey };
      let dayTotal = 0;

      restaurants.forEach(([id]) => {
        const count = dayMap.get(id) || 0;
        rowData[id] = count;
        dayTotal += count;
        restaurantTotals.set(id, (restaurantTotals.get(id) || 0) + count);
      });

      rowData.total = dayTotal;
      grandTotal += dayTotal;
      worksheet.addRow(rowData);
    });

    // Ligne de totaux
    const totalRowData: Record<string, any> = { date: 'TOTAL' };
    restaurants.forEach(([id]) => {
      totalRowData[id] = restaurantTotals.get(id) || 0;
    });
    totalRowData.total = grandTotal;
    const totalRow = worksheet.addRow(totalRowData);

    totalRow.font = { bold: true };
    totalRow.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE5E7EB' },
    };

    // Alignement des colonnes numériques
    restaurants.forEach(([id]) => {
      worksheet.getColumn(id).alignment = { horizontal: 'center' };
      worksheet.getColumn(id).numFmt = '#,##0';
    });
    worksheet.getColumn('total').alignment = { horizontal: 'center' };
    worksheet.getColumn('total').numFmt = '#,##0';

    // Bordures
    worksheet.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: true }, (cell) => {
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFD1D5DB' } },
          left: { style: 'thin', color: { argb: 'FFD1D5DB' } },
          bottom: { style: 'thin', color: { argb: 'FFD1D5DB' } },
          right: { style: 'thin', color: { argb: 'FFD1D5DB' } },
        };
      });
    });

    // Alternance de couleurs
    worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber > 1 && rowNumber < worksheet.rowCount) {
        if (rowNumber % 2 === 0) {
          row.fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFF9FAFB' },
          };
        }
      }
    });

    const buffer = await workbook.xlsx.writeBuffer();

    return {
      buffer,
      filename: `livraisons-par-restaurant-${new Date().toISOString().split('T')[0]}.xlsx`,
    };
  }

  // Obtenir les frais de livraison, API utilisée avant de passer la commande
  async obtenirFraisLivraison(body: FraisLivraisonDto): Promise<{
    montant: number;
    zone: string;
    distance: number;
    service: DeliveryService;
    zone_id: string | null;
  }> {
    // Récupérer le restaurant le plus proche
    const restaurant = await this.orderHelper.getClosestRestaurant({
      restaurant_id: body.restaurant_id,
      address: JSON.stringify({ latitude: body.lat, longitude: body.long }),
    });

    return await this.deliveryFeeHelper.calculeFraisLivraison({
      lat: body.lat,
      long: body.long,
      restaurant,
      channel: 'APP',
      orderAmount: body.order_amount ?? 0,
    });
  }
}
