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
  Prisma,
} from '@prisma/client';
import { format, startOfMonth } from 'date-fns';
import { fr } from 'date-fns/locale';
import * as ExcelJS from 'exceljs';
import { Request } from 'express';
import { QueryResponseDto } from 'src/common/dto/query-response.dto';
import { GenerateDataService } from 'src/common/services/generate-data.service';
import { PrismaService } from 'src/database/services/prisma.service';
import { CreateOrderDto } from '../dto/create-order.dto';
import { FraisLivraisonDto } from '../dto/frais-livrasion.dto';
import { QueryOrderCustomerDto, QueryOrderDto } from '../dto/query-order.dto';
import { UpdateOrderDto } from '../dto/update-order.dto';
import { OrderEvent } from '../events/order.event';
import { OrderHelper } from '../helpers/order.helper';
import { OrderWebSocketService } from '../websockets/order-websocket.service';

@Injectable()
export class OrderService {
  private readonly logger = new Logger(OrderService.name);
  constructor(
    private prisma: PrismaService,
    private generateDataService: GenerateDataService,
    private orderHelper: OrderHelper,
    private orderEvent: OrderEvent,
    private readonly orderWebSocketService: OrderWebSocketService,
  ) { }

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
          status: OrderStatus.PENDING,
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

    // Mettre à jour le statut
    const updatedOrder = await this.prisma.order.update({
      where: { id },
      data: {
        estimated_delivery_time: this.orderHelper.calculateEstimatedTime(
          meta?.estimated_delivery_time ?? '',
        ),
        estimated_preparation_time: this.orderHelper.calculateEstimatedTime(
          meta?.estimated_preparation_time ?? '',
        ),
        updated_at: new Date(),
        status:
          status == OrderStatus.ACCEPTED ? OrderStatus.IN_PROGRESS : status,
        ...(status === OrderStatus.ACCEPTED && { accepted_at: new Date(), prepared_at: new Date() }),
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
          },
        },
        restaurant: true,
      },
    });

    // Envoyer l'événement de mise à jour de statut de commande
    this.orderEvent.orderStatusUpdatedEvent({
      order: updatedOrder,
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
    const order = await this.prisma.order.findFirst({
      where: {
        id,
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
    if (filters.auto == undefined) {
      where.OR = [
        {
          AND: [{ paied: false }, { auto: false }],
        },
        {
          paied: true,
        },
      ];
    } else {
      if (filters.auto === true) {
        where.auto = true;
        where.paied = true;
      } else {
        where.auto = false;
      }
    }

    if (filters.startDate && filters.endDate) {
      where.created_at = {
        gte: filters.startDate,
        lte: new Date(new Date(filters.endDate).setHours(23, 59, 59, 999)),
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
    console.log('filters', filters);
    const customerId = (req.user as Customer).id;
    const where: Prisma.OrderWhereInput = {
      OR: [
        {
          AND: [{ paied: false }, { auto: false }],
        },
        {
          paied: true,
        },
      ],
      entity_status: { not: EntityStatus.DELETED },
      ...(statusFilter && {
        ...(statusFilter == 'processing'
          ? { status: { in: [OrderStatus.PENDING, OrderStatus.ACCEPTED, OrderStatus.IN_PROGRESS, OrderStatus.READY, OrderStatus.PICKED_UP] } }
          : statusFilter == 'completed'
            ? { status: { in: [OrderStatus.COLLECTED, OrderStatus.COMPLETED] } }
            : statusFilter == 'cancelled'
              ? { status: OrderStatus.CANCELLED }
              : {}),
      }),
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
      where: { id },
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
      where: { id },
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
      status: OrderStatus.COMPLETED,
      paied: true,
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

    if (filters.auto == undefined) {
      where.OR = [
        {
          AND: [{ paied: false }, { auto: false }],
        },
        {
          paied: true,
        },
      ];
    } else {
      if (filters.auto === true) {
        where.auto = true;
        where.paied = true;
      } else {
        where.auto = false;
      }
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
