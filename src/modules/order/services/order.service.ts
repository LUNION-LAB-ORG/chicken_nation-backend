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
  PaymentMethod,
  Prisma,
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
import { OrderCreateDto } from '../dto/order-create.dto';
import * as puppeteer from 'puppeteer';
import { VoucherService } from 'src/modules/voucher/voucher.service';

@Injectable()
export class OrderService {
  private readonly logger = new Logger(OrderService.name);
  constructor(
    private prisma: PrismaService,
    private generateDataService: GenerateDataService,
    private orderHelper: OrderHelper,
    private orderHelperV2: OrderV2Helper,
    private orderEvent: OrderEvent,
    private readonly orderWebSocketService: OrderWebSocketService,
    private voucherService: VoucherService

  ) { }

  async createv2(customer_id: string, createOrderDto: OrderCreateDto): Promise<Order> {
    const {
      items, address, restaurant_id, delivery_fee, type, code_promo, date, fullname, phone, email, payment_method, points
    } = createOrderDto;

    // 1. Gestion de la Date (Le format ISO géré par le nouveau DTO)
    let finalDate = date && typeof date === 'string' ? new Date(date) : new Date();

    // 2. Client
    const customerData = await this.orderHelperV2.resolveCustomerData({
      customer_id, fullname, phone, email,
    });

    // 3. Récupération globale des Plats & Calculs
    const dishIds = items.map((item) => item.dish_id);
    const dishesWithDetails = await this.orderHelperV2.getDishesWithDetails(dishIds);


    // Ton algorithme ajusté !
    const { orderItems, netAmount, totalDishes } = await this.orderHelperV2.calculateOrderDetails(items, dishesWithDetails);

    const promoDiscount = await this.orderHelperV2.applyPromoCode(code_promo, customerData.customer_id, netAmount);

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

    if (type === OrderType.DELIVERY) {
      // 📍 LIVRAISON : Attribution automatique selon la distance et le stock
      if (!address) throw new BadRequestException("L'adresse est obligatoire pour une livraison.");
      const addressData = await this.orderHelperV2.validateAddress(address);

      restaurant = await this.orderHelperV2.findEligibleDeliveryRestaurant(addressData, dishIds);
      if (delivery_fee) {
        finalDeliveryFee = delivery_fee;
      } else {
        delivery = await this.orderHelperV2.calculeFraisLivraison({
          lat: addressData.latitude,
          long: addressData.longitude,
          restaurant,
        });
        finalDeliveryFee = delivery.montant;
      }

      finalDeliveryFee = delivery_fee ?? delivery.montant;

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
      return await prisma.order.create({
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
          delivery_service: delivery ? delivery.service : DeliveryService.TURBO,
          zone_id: delivery?.zone_id,
          tax: Number(tax),
          discount: Number(discount),
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
    });

    // Apply voucher
    if (code_promo && order) {
      await this.voucherService.redeemVoucher(code_promo, customerData.customer_id, {
        orderId: order.id,
        amount: Number(promoDiscount),
      });
    }
    if (next_status === OrderStatus.ACCEPTED) {
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

      // Émettre l'événement de création de commande
      this.orderWebSocketService.emitOrderCreated(order);
    }

    return order;
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

    // Calculer les montants et préparer les order items
    const { orderItems, netAmount, totalDishes } =
      await this.orderHelper.calculateOrderDetails(items, dishesWithDetails);

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
      delivery = await this.orderHelper.calculeFraisLivraison({
        lat: addressData.latitude,
        long: addressData.longitude,
        restaurant,
      });
    } else {
      restaurant = await this.orderHelper.getClosestRestaurant({
        restaurant_id: restaurant_id,
        address,
      });
    }
    // Montant frais de livraison
    const deliveryFee = delivery_fee || (delivery ? delivery?.montant : 0);

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
          delivery_service: delivery ? delivery.service : DeliveryService.TURBO,
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
    }

    return order;
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
    //Meta peut contenir estimated_delivery_time, estimated_preparation_time, deliveryDriverId
    // Valider la transition d'état
    this.orderHelper.validateStatusTransition(order.type, order.status, status);

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

    // Envoyer l'événement de mise à jour de statut de commande
    this.orderEvent.orderStatusUpdatedEvent({
      order: updatedOrder,
      expo_token: updatedOrder.customer.notification_settings?.expo_push_token,
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
        restaurant: {
          select: {
            id: true,
            name: true,
            image: true,
            address: true,
            phone: true,
            email: true,
          },
        },
      },
    });

    if (!order) {
      throw new NotFoundException(`Commande est introuvable`);
    }

    return order;
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
        customer: true,
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
  async findAll(filters: QueryOrderDto): Promise<QueryResponseDto<Order>> {
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
    }

    return updatedOrder;
  }
  /**
   * Met à jour une commande
   */
  async update(id: string, updateOrderDto: UpdateOrderDto) {
    const order = await this.findById(id);
    const { paiement_id, delivery_fee, ...rest } = updateOrderDto;
    // Vérifier que la commande peut être modifiée (seulement si PENDING)
    if (order.status !== OrderStatus.PENDING) {
      throw new ConflictException(
        'Seules les commandes en attente peuvent être modifiées',
      );
    }

    // Appliquer les modifications
    const updatedOrder = await this.prisma.order.update({
      where: { id: order.id },
      data: {
        ...rest,
        delivery_fee,
        estimated_delivery_time: this.orderHelper.calculateEstimatedTime(
          rest?.estimated_delivery_time ?? '',
        ),
        estimated_preparation_time: this.orderHelper.calculateEstimatedTime(
          rest?.estimated_preparation_time ?? '',
        ),
        updated_at: new Date(),
      },
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

    // Envoyer l'événement de mise à jour de statut de commande
    this.orderEvent.orderUpdatedEvent(updatedOrder, updateOrderDto);

    // Émettre via WebSocket
    this.orderWebSocketService.emitOrderUpdated(updatedOrder);
    return updatedOrder;
  }

  /**
   * Supprime une commande (soft delete)
   */
  async remove(id: string) {
    const order = await this.findById(id);

    // Vérifier que la commande peut être supprimée
    if (
      order.status !== OrderStatus.PENDING &&
      order.status !== OrderStatus.CANCELLED
    ) {
      throw new ConflictException(
        'Seules les commandes en attente ou annulées peuvent être supprimées',
      );
    }

    const orderDeleted = this.prisma.order.update({
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

    // Données
    orders.forEach((order) => {
      const montantNet = order.net_amount - order.discount;
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
    });

    // Formatage des colonnes monétaires (nombres avec séparateur de milliers)
    const currencyColumns = [
      'amount',
      'net_amount',
      'montant_net',
      'delivery_fee',
      'tax',
      'discount',
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
     * Génère les données et la structure pour le PDF des commandes d'un restaurant
     */
  async exportRestaurantOrdersToPDF(filters: QueryOrderDto) {
    const { restaurantId, startDate, endDate, sortBy = 'created_at', sortOrder = 'desc' } = filters;

    if (!restaurantId) {
      throw new BadRequestException("L'ID du restaurant est obligatoire pour générer ce rapport.");
    }

    const statusTranslations: Record<OrderStatus, string> = {
      [OrderStatus.PENDING]: 'En attente',
      [OrderStatus.CANCELLED]: 'Annulé',
      [OrderStatus.ACCEPTED]: 'Accepté',
      [OrderStatus.IN_PROGRESS]: 'En cours',
      [OrderStatus.READY]: 'Prêt',
      [OrderStatus.PICKED_UP]: 'En livraison',
      [OrderStatus.COLLECTED]: 'Collecté (Client)',
      [OrderStatus.COMPLETED]: 'Terminé',
    };

    const typeTranslations: Record<OrderType, string> = {
      [OrderType.DELIVERY]: 'Livraison',
      [OrderType.PICKUP]: 'Emporter',
      [OrderType.TABLE]: 'Table',
    };

    const where: Prisma.OrderWhereInput = {
      restaurant_id: restaurantId,
      entity_status: { not: EntityStatus.DELETED },
    };
    where.OR = [
      {
        AND: [{ paied: false }, { auto: false }],
      },
      {
        paied: true,
      },
    ];
    if (startDate && endDate) {
      where.created_at = {
        gte: new Date(startDate),
        lte: new Date(new Date(endDate).setHours(23, 59, 59, 999)),
      };
    }

    const orders = await this.prisma.order.findMany({
      where,
      include: {
        customer: { select: { first_name: true, last_name: true, phone: true } },
        restaurant: { select: { name: true } }
      },
      orderBy: { [sortBy]: sortOrder },
    });

    if (orders.length === 0) {
      throw new NotFoundException("Aucune commande trouvée pour cette période.");
    }

    const restaurantName = orders[0].restaurant.name;
    const totalOrders = orders.length;

    // 📊 INITIALISATION DES STATISTIQUES
    const stats = {
      completedCount: 0,
      completedAmount: 0,
      cancelledCount: 0,
      cancelledAmount: 0,
      restaurantDelayCount: 0, // Prép > 20 min
      deliveryDelayCount: 0,   // Livr > 40 min
      typeDelivery: 0,
      typePickup: 0,
      typeTable: 0,
    };

    // 🔄 Formatage et Calcul des statistiques
    const formattedOrders = orders.map((order) => {
      // 1. Catégorisation par type
      if (order.type === OrderType.DELIVERY) stats.typeDelivery++;
      else if (order.type === OrderType.PICKUP) stats.typePickup++;
      else if (order.type === OrderType.TABLE) stats.typeTable++;

      // 2. Chiffre d'affaires et Statuts globaux
      // On considère comme terminées les commandes "COMPLETED" ou "COLLECTED"
      const isCompleted = order.status === OrderStatus.COMPLETED || order.status === OrderStatus.COLLECTED;
      if (isCompleted) {
        stats.completedCount++;
        stats.completedAmount += order.amount;
      } else if (order.status === OrderStatus.CANCELLED) {
        stats.cancelledCount++;
        stats.cancelledAmount += order.amount;
      }

      // 3. Calcul Temps de préparation
      let prepTime = '-';
      if (order.created_at && order.ready_at) {
        const diffPrep = differenceInMinutes(new Date(order.ready_at), new Date(order.created_at));
        prepTime = `${diffPrep} min`;
        if (diffPrep > 20) stats.restaurantDelayCount++;
      }

      // 4. Calcul Temps de livraison/retrait
      let deliveryTime = '-';
      const endStatusDate = order.collected_at || order.picked_up_at || order.completed_at;
      if (order.ready_at && endStatusDate) {
        const diffDeliv = differenceInMinutes(new Date(endStatusDate), new Date(order.ready_at));
        deliveryTime = `${diffDeliv} min`;
        if (diffDeliv > 40) stats.deliveryDelayCount++;
      }

      const clientName = order.fullname || [order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(' ') || 'Client Inconnu';

      return {
        reference: order.reference,
        date: format(new Date(order.created_at), 'dd/MM/yyyy HH:mm', { locale: fr }),
        prepTime,
        deliveryTime,
        clientName,
        clientPhone: order.phone || order.customer?.phone || '-',
        status: statusTranslations[order.status] || order.status,
        rawStatus: order.status,
        type: typeTranslations[order.type] || order.type,
        rawType: order.type,
        amount: order.amount,
        source: order.auto ? 'Appli' : 'Manuel',
      };
    });

    // 🧮 Helpers pour calculer les taux en %
    const calcRate = (count: number) => totalOrders > 0 ? ((count / totalOrders) * 100).toFixed(1) : '0.0';

    // 🎨 Génération du template HTML
    const htmlTemplate = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: 'Helvetica', sans-serif; padding: 20px; color: #1f2937; margin: 0; }
          .header { text-align: center; margin-bottom: 20px; border-bottom: 2px solid #F17922; padding-bottom: 15px; }
          h1 { color: #F17922; margin: 0 0 5px 0; font-size: 24px; }
          h2 { color: #4b5563; margin: 0 0 5px 0; font-size: 18px; }
          p.period { color: #6b7280; font-size: 14px; margin: 0; }
          
          /* Kpis Dashboard */
          .dashboard { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 25px; }
          .kpi-card { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px; flex: 1; min-width: 150px; text-align: center; }
          .kpi-title { font-size: 11px; text-transform: uppercase; color: #6b7280; font-weight: bold; margin-bottom: 5px; }
          .kpi-value { font-size: 18px; font-weight: bold; color: #111827; }
          .kpi-sub { font-size: 12px; color: #F17922; font-weight: bold; margin-top: 4px; }
          .kpi-alert { color: #dc2626; } /* Rouge pour les retards */
          
          .recap-types { background: #fff7ed; border: 1px solid #fed7aa; padding: 10px; border-radius: 8px; margin-bottom: 20px; display: flex; justify-content: space-around; font-size: 13px; font-weight: bold; color: #c2410c; }
          
          /* Table */
          table { width: 100%; border-collapse: collapse; font-size: 10px; }
          th { background-color: #F17922; color: white; padding: 8px; text-align: left; }
          td { padding: 8px; border-bottom: 1px solid #e5e7eb; }
          tr:nth-child(even) { background-color: #f9fafb; }
          .amount { font-weight: bold; text-align: right; }
          .total-row { background-color: #f3f4f6; font-weight: bold; font-size: 12px; }
          
          /* Badges */
          .badge { padding: 3px 6px; border-radius: 4px; font-weight: bold; font-size: 9px; }
          .badge-COMPLETED, .badge-COLLECTED { background-color: #dcfce7; color: #166534; }
          .badge-CANCELLED { background-color: #fee2e2; color: #991b1b; }
          .badge-PENDING { background-color: #fef3c7; color: #92400e; }
          .badge-IN_PROGRESS, .badge-ACCEPTED { background-color: #e0f2fe; color: #075985; }
          .badge-READY { background-color: #fef08a; color: #854d0e; }
          .badge-PICKED_UP { background-color: #ffedd5; color: #9a3412; }
        </style>
      </head>
      <body>
        <div class="header">
          <h1>Rapport d'Activité</h1>
          <h2>Restaurant : ${restaurantName}</h2>
          <p class="period">Période : ${startDate ? format(new Date(startDate), 'dd/MM/yyyy') : 'Début'} - ${endDate ? format(new Date(endDate), 'dd/MM/yyyy') : "Aujourd'hui"}</p>
        </div>

        <div class="dashboard">
          <div class="kpi-card">
            <div class="kpi-title">Total Commandes</div>
            <div class="kpi-value">${totalOrders}</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-title">Terminées (${calcRate(stats.completedCount)}%)</div>
            <div class="kpi-value" style="color: #166534;">${stats.completedCount}</div>
            <div class="kpi-sub" style="color: #166534;">${stats.completedAmount.toLocaleString()} FCFA</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-title">Annulées (${calcRate(stats.cancelledCount)}%)</div>
            <div class="kpi-value" style="color: #dc2626;">${stats.cancelledCount}</div>
            <div class="kpi-sub" style="color: #dc2626;">${stats.cancelledAmount.toLocaleString()} FCFA</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-title">Retards Prép. > 20m</div>
            <div class="kpi-value kpi-alert">${stats.restaurantDelayCount} <span style="font-size:12px">(${calcRate(stats.restaurantDelayCount)}%)</span></div>
          </div>
          <div class="kpi-card">
            <div class="kpi-title">Retards Livr. > 40m</div>
            <div class="kpi-value kpi-alert">${stats.deliveryDelayCount} <span style="font-size:12px">(${calcRate(stats.deliveryDelayCount)}%)</span></div>
          </div>
        </div>

        <div class="recap-types">
          <span>🚚 Livraison : ${stats.typeDelivery}</span>
          <span>🛍️ À emporter : ${stats.typePickup}</span>
          <span>🍽️ Sur place : ${stats.typeTable}</span>
        </div>

        <table>
          <thead>
            <tr>
              <th>Réf.</th>
              <th>Date</th>
              <th>Client</th>
              <th>Téléphone</th>
              <th>Prépa.</th>
              <th>Livr/Retrait</th>
              <th>Type</th>
              <th>Statut</th>
              <th style="text-align: right;">Montant</th>
            </tr>
          </thead>
          <tbody>
            ${formattedOrders.map(o => `
              <tr>
                <td>${o.reference}</td>
                <td>${o.date}</td>
                <td>${o.clientName}</td>
                <td>${o.clientPhone}</td>
                <td style="${o.prepTime !== '-' && parseInt(o.prepTime) > 20 ? 'color: red; font-weight: bold;' : ''}">${o.prepTime}</td>
                <td style="${o.deliveryTime !== '-' && parseInt(o.deliveryTime) > 40 ? 'color: red; font-weight: bold;' : ''}">${o.deliveryTime}</td>
                <td><span class="badge badge-${o.rawType}">${o.type}</span></td>
                <td><span class="badge badge-${o.rawStatus}">${o.status}</span></td>
                <td class="amount">${o.amount.toLocaleString()} FCFA</td>
              </tr>
            `).join('')}
            <tr class="total-row">
              <td colspan="7" style="text-align: right; padding: 12px;">CHIFFRE D'AFFAIRES BRUT (Toutes commandes confondues) :</td>
              <td class="amount" style="padding: 12px;">${formattedOrders.reduce((acc, curr) => acc + curr.amount, 0).toLocaleString()} FCFA</td>
            </tr>
          </tbody>
        </table>
      </body>
      </html>
    `;

    // 📄 GÉNÉRATION DU PDF AVEC PUPPETEER
    let pdfBuffer: Uint8Array;
    try {
      const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
      const page = await browser.newPage();

      await page.setContent(htmlTemplate, { waitUntil: 'networkidle0' });

      pdfBuffer = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '1cm', right: '1cm', bottom: '1cm', left: '1cm' }
      });

      await browser.close();
    } catch (error) {
      this.logger.error("Erreur Puppeteer lors de la génération du PDF", error);
      throw new BadRequestException("Impossible de générer le fichier PDF.");
    }

    const safeRestaurantName = restaurantName.replace(/[^a-zA-Z0-9]/g, '_');
    const safeDate = format(new Date(), 'yyyy-MM-dd');
    const filename = `Rapport_${safeRestaurantName}_${safeDate}.pdf`;

    return {
      buffer: Buffer.from(pdfBuffer),
      filename,
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

    return await this.orderHelper.calculeFraisLivraison({
      lat: body.lat,
      long: body.long,
      restaurant,
    });
  }
}
