import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { CreateOrderDto } from '../dto/create-order.dto';
import { UpdateOrderDto } from '../dto/update-order.dto';
import { OrderStatus, EntityStatus, Customer, Order, Prisma } from '@prisma/client';
import { PrismaService } from 'src/database/services/prisma.service';
import { Request } from 'express';
import { QueryOrderDto } from '../dto/query-order.dto';
import { GenerateDataService } from 'src/common/services/generate-data.service';
import { OrderHelper } from '../helpers/order.helper';
import { QueryResponseDto } from 'src/common/dto/query-response.dto';
import { OrderEvent } from '../events/order.event';
import { OrderWebSocketService } from '../websockets/order-websocket.service';

@Injectable()
export class OrderService {

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

    const customer = req.user as Customer;

    const { items, paiement_id, customer_id, restaurant_id, promotion_id, points, ...orderData } = createOrderDto;

    // Identifier le client ou créer à partir des données
    const customerData = await this.orderHelper.resolveCustomerData({ ...createOrderDto, customer_id: customer_id ?? customer.id });

    // Récupérer le restaurant le plus proche
    const restaurant = await this.orderHelper.getClosestRestaurant(createOrderDto);

    // Récupérer les plats et vérifier leur disponibilité
    const dishesWithDetails = await this.orderHelper.getDishesWithDetails(items.map(item => item.dish_id));

    // Vérifier l'adresse
    const address = await this.orderHelper.validateAddress(orderData.address ?? "");

    // Vérifier et appliquer le code promo s'il existe
    const promoDiscount = await this.orderHelper.applyPromoCode(orderData.code_promo);

    // Calculer les montants et préparer les order items
    const { orderItems, netAmount, totalDishes } = await this.orderHelper.calculateOrderDetails(items, dishesWithDetails);

    //Calculer la promotion et la création de l'utilisation de la promotion
    const discountPromotion = await this.orderHelper.calculatePromotionPrice(
      promotion_id ?? "",
      { customer_id: customerData.customer_id, loyalty_level: customerData.loyalty_level },
      totalDishes,
      orderItems.map(item => ({ dish_id: item.dish_id, quantity: item.quantity, price: item.dishPrice }))
    );

    // Calculer les frais de livraison selon la distance
    const deliveryFee = await this.orderHelper.calculateDeliveryFee(orderData.type, address);

    // Vérifier le paiement
    const payment = await this.orderHelper.checkPayment(createOrderDto);

    // Calculer le montant de réduction des points de fidélité
    const loyaltyFee = await this.orderHelper.calculateLoyaltyFee(customerData.total_points, points ?? 0);

    // Calculer la taxe et le montant total
    const tax = await this.orderHelper.calculateTax(netAmount);

    const totalBeforeDiscount = netAmount + deliveryFee + tax;
    const discount = (totalBeforeDiscount * promoDiscount) + loyaltyFee + discountPromotion;
    const totalAmount = totalBeforeDiscount - discount;

    if (payment && payment.amount < totalAmount) {
      throw new BadRequestException('Le montant du paiement est inférieur au montant de la commande');
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
          ...(discountPromotion && { promotion: { connect: { id: promotion_id } } }),
          customer: {
            connect: {
              id: customerData.customer_id
            }
          },
          restaurant: {
            connect: {
              id: restaurant.id
            }
          },
          reference: orderNumber,
          ...(payment && { paiements: { connect: { id: payment.id } } }),
          delivery_fee: Number(deliveryFee),
          tax: Number(tax),
          discount: Number(discount),
          net_amount: Number(netAmount),
          amount: Number(totalAmount),
          date: orderData.date || new Date(),
          time: orderData.time || "10:00",
          status: OrderStatus.PENDING,
          paied_at: payment ? payment.created_at : null,
          paied: payment ? true : false,
          order_items: {
            create: orderItems.map(item => ({
              dish_id: item.dish_id,
              quantity: item.quantity,
              amount: item.amount,
              supplements: item.supplements
            })),
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

    // Envoyer l'événement de création de commande
    this.orderEvent.orderCreatedEvent({
      order,
      payment_id: payment?.id,
      loyalty_level: customerData.loyalty_level,
      totalDishes,
      orderItems: orderItems.map(item => ({ dish_id: item.dish_id, quantity: item.quantity, price: item.dishPrice })),
    });

    // Émettre l'événement de création de commande
    this.orderWebSocketService.emitOrderCreated(order);

    return order;
  }

  /**
   * Met à jour le statut d'une commande
   */
  async updateStatus(id: string, status: OrderStatus, meta?: Record<string, any>) {
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
        status: status == OrderStatus.ACCEPTED ? OrderStatus.IN_PROGRESS : status,
        estimated_delivery_time: this.orderHelper.calculateEstimatedTime(meta?.estimated_delivery_time ?? ""),
        estimated_preparation_time: this.orderHelper.calculateEstimatedTime(meta?.estimated_preparation_time ?? ""),
        updated_at: new Date(),
        ...(status === OrderStatus.COMPLETED && { completed_at: new Date() }),
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
      order: updatedOrder
    });

    // Émettre l'événement de mise à jour de statut avec l'ancien statut
    this.orderWebSocketService.emitStatusUpdate(
      updatedOrder,
      order.status
    );

    return updatedOrder;
  }

  /**
   * Récupère une commande par son ID
   */
  async findById(id: string) {
    if (!id) {
      throw new BadRequestException('L\'identifiant de la commande est requis');
    }
    const order = await this.prisma.order.findFirst({
      where: {
        id,
        entity_status: { not: EntityStatus.DELETED }
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
   * Recherche et filtre les commandes
   */
  async findAll(filters: QueryOrderDto): Promise<QueryResponseDto<Order>> {
    const {
      status,
      type,
      customerId,
      restaurantId,
      startDate,
      endDate,
      minAmount,
      maxAmount,
      page = 1,
      limit = 10,
      sortBy = 'created_at',
      sortOrder = 'desc'
    } = filters;

    const where: Prisma.OrderWhereInput = {
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
      ...(restaurantId && { restaurant_id: restaurantId })
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
          [sortBy]: sortOrder,
        },
      }),
      this.prisma.order.count({ where })
    ]);

    return {
      data: orders,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      }
    };
  }

  /**
   * Recherche et filtre les commandes d'un client
   */
  async findAllByCustomer(req: Request, filters: QueryOrderDto): Promise<QueryResponseDto<Order>> {
    const {
      status,
      type,
      restaurantId,
      startDate,
      endDate,
      minAmount,
      maxAmount,
      page = 1,
      limit = 10,
      sortBy = 'created_at',
      sortOrder = 'desc'
    } = filters;
    const customerId = (req.user as Customer).id;
    const where: Prisma.OrderWhereInput = {
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
          [sortBy]: sortOrder,
        },
      }),
      this.prisma.order.count({ where })
    ]);

    return {
      data: orders,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      }
    };
  }

  /**
   * Met à jour une commande
   */
  async update(id: string, updateOrderDto: UpdateOrderDto) {
    const order = await this.findById(id);
    const { paiement_id, ...rest } = updateOrderDto;
    // Vérifier que la commande peut être modifiée (seulement si PENDING)
    if (order.status !== OrderStatus.PENDING) {
      throw new ConflictException('Seules les commandes en attente peuvent être modifiées');
    }

    // Appliquer les modifications
    const updatedOrder = await this.prisma.order.update({
      where: { id },
      data: {
        ...rest,
        estimated_delivery_time: this.orderHelper.calculateEstimatedTime(rest?.estimated_delivery_time ?? ""),
        estimated_preparation_time: this.orderHelper.calculateEstimatedTime(rest?.estimated_preparation_time ?? ""),
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
    if (order.status !== OrderStatus.PENDING && order.status !== OrderStatus.CANCELLED) {
      throw new ConflictException('Seules les commandes en attente ou annulées peuvent être supprimées');
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
    const where: Prisma.OrderWhereInput = this.orderHelper.buildWhereClause(filters);

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
      this.prisma.order.count({ where }),

      // Montant total des ventes
      this.prisma.order.aggregate({
        where,
        _sum: { amount: true },
      }),

      // Commandes par statut
      this.prisma.order.groupBy({
        by: ['status'],
        where,
        _count: true,
      }),

      // Commandes par type
      this.prisma.order.groupBy({
        by: ['type'],
        where,
        _count: true,
      }),

      // Commandes récentes
      this.prisma.order.findMany({
        where,
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
        where,
        _avg: { amount: true },
      }),

      // Plats les plus commandés
      this.prisma.orderItem.groupBy({
        by: ['dish_id'],
        where: {
          order: where,
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
      }).then(async (items) => {
        const dishIds = items.map(item => item.dish_id);
        const dishes = await this.prisma.dish.findMany({
          where: { id: { in: dishIds } },
        });

        return items.map(item => ({
          ...item,
          dish: dishes.find(d => d.id === item.dish_id),
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


  async updateStatuts(id: string) {
    const order = await this.findById(id);

    if (!order) {
      throw new NotFoundException('Commande non trouvée');
    }

    // Émettre l'événement de mise à jour de statut
    this.orderWebSocketService.emitStatusUpdate(order, OrderStatus.ACCEPTED);
  }
}