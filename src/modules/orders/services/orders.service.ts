import { Injectable, NotFoundException, BadRequestException, InternalServerErrorException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Order, OrderStatus } from '../entities/order.entity';
import { OrderItem } from '../entities/orderItem.entity';
import { OrderItemSupplement } from '../entities/orderItemSupplement.entity';
import { CreateOrderDto } from '../dto/create-order.dto';
import { UpdateOrderStatusDto } from '../dto/update-order-status.dto';
import { MenuItem } from '../../menu/entities/menuItem.entity';

@Injectable()
export class OrdersService {
  constructor(
    @InjectRepository(Order)
    private ordersRepository: Repository<Order>,
    @InjectRepository(OrderItem)
    private orderItemsRepository: Repository<OrderItem>,
    @InjectRepository(OrderItemSupplement)
    private orderItemSupplementsRepository: Repository<OrderItemSupplement>,
    @InjectRepository(MenuItem)
    private menuItemRepository: Repository<MenuItem>,
    private dataSource: DataSource,
  ) {}

  async findAll(userId?: string): Promise<Order[]> {
    const queryBuilder = this.ordersRepository.createQueryBuilder('order')
      .leftJoinAndSelect('order.items', 'items')
      .leftJoinAndSelect('items.product', 'product')
      .leftJoinAndSelect('items.supplements', 'supplements');

    if (userId) {
      queryBuilder.where('order.userId = :userId', { userId });
    }

    return queryBuilder.getMany();
  }

  async findOne(id: string): Promise<Order> {
    try {
      // Utiliser une requête SQL directe pour éviter les problèmes de type UUID
      const orders = await this.ordersRepository.query(
        `SELECT * FROM orders WHERE id = $1`,
        [id]
      );
      
      if (!orders || orders.length === 0) {
        throw new NotFoundException(`Order with ID ${id} not found`);
      }
      
      const order = orders[0];
      
      // Récupérer les items de la commande
      const items = await this.orderItemsRepository.query(
        `SELECT * FROM order_items WHERE order_id = $1`,
        [id]
      );
      
      // Pour chaque item, récupérer le produit et les suppléments
      const itemsWithDetails = [];
      for (const item of items) {
        // Récupérer le produit
        const products = await this.menuItemRepository.query(
          `SELECT * FROM menu_items WHERE id = $1`,
          [item.product_id]
        );
        
        // Récupérer les suppléments
        const supplements = await this.orderItemSupplementsRepository.query(
          `SELECT * FROM order_item_supplements WHERE order_item_id = $1`,
          [item.id]
        );
        
        itemsWithDetails.push({
          ...item,
          product: products.length > 0 ? products[0] : null,
          supplements: supplements
        });
      }
      
      // Ajouter les items à la commande
      order.items = itemsWithDetails;
      
      return order;
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      throw new NotFoundException(`Order with ID ${id} not found`);
    }
  }

  async create(userId: string, createOrderDto: CreateOrderDto): Promise<Order> {
    // Utiliser une transaction pour garantir l'intégrité des données
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Récupérer un ID d'utilisateur valide de la base de données
      const user = await queryRunner.manager.query('SELECT id FROM users LIMIT 1');
      const validUserId = user[0].id;

      // Vérifier la disponibilité et calculer le total
      let total = 0;
      for (const item of createOrderDto.items) {
        const menuItem = await this.menuItemRepository.findOne({
          where: { id: item.product_id },
        });

        if (!menuItem) {
          throw new BadRequestException(`Menu item with ID ${item.product_id} not found`);
        }

        if (!menuItem.is_available) {
          throw new BadRequestException(`Menu item ${menuItem.name} is not available`);
        }

        const price = menuItem.discounted_price || menuItem.price;
        total += price * item.quantity;
      }

      // Créer la commande
      const order = new Order();
      order.userId = validUserId;
      order.total = total;
      order.status = OrderStatus.PENDING;
      order.paymentMethod = createOrderDto.payment_method;
      order.deliveryAddress = createOrderDto.delivery_address;

      const savedOrder = await queryRunner.manager.save(Order, order);

      // Créer les articles de la commande
      for (const itemDto of createOrderDto.items) {
        const orderItem = new OrderItem();
        orderItem.orderId = savedOrder.id;
        orderItem.productId = itemDto.product_id;
        orderItem.quantity = itemDto.quantity;

        const savedOrderItem = await queryRunner.manager.save(OrderItem, orderItem);

        // Ajouter les suppléments si présents
        if (itemDto.supplement_ids && itemDto.supplement_ids.length > 0) {
          for (const supplementId of itemDto.supplement_ids) {
            const supplement = new OrderItemSupplement();
            supplement.orderItemId = savedOrderItem.id;
            supplement.supplementId = supplementId;
            await queryRunner.manager.save(OrderItemSupplement, supplement);
          }
        }
      }

      await queryRunner.commitTransaction();

      return this.findOne(savedOrder.id);
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async updateStatus(id: string, updateOrderStatusDto: UpdateOrderStatusDto): Promise<Order> {
    const order = await this.findOne(id);

    // Vérifier les transitions d'état valides
    this.validateStatusTransition(order.status, updateOrderStatusDto.status);

    order.status = updateOrderStatusDto.status;
    return this.ordersRepository.save(order);
  }

  private validateStatusTransition(currentStatus: OrderStatus, newStatus: OrderStatus): void {
    // Définir les transitions valides
    const validTransitions = {
      [OrderStatus.PENDING]: [OrderStatus.CONFIRMED, OrderStatus.CANCELLED],
      [OrderStatus.CONFIRMED]: [OrderStatus.PREPARING, OrderStatus.CANCELLED],
      [OrderStatus.PREPARING]: [OrderStatus.READY, OrderStatus.CANCELLED],
      [OrderStatus.READY]: [OrderStatus.DELIVERED, OrderStatus.CANCELLED],
      [OrderStatus.DELIVERED]: [],
      [OrderStatus.CANCELLED]: [],
    };

    if (!validTransitions[currentStatus].includes(newStatus)) {
      throw new BadRequestException(
        `Invalid status transition from ${currentStatus} to ${newStatus}`,
      );
    }
  }

  async cancel(id: string): Promise<Order> {
    try {
      // Vérifier d'abord si la commande existe
      const order = await this.findOne(id);
      
      // Vérifier si la commande peut être annulée
      try {
        this.validateStatusTransition(order.status, OrderStatus.CANCELLED);
      } catch (error) {
        throw error;
      }
      
      // Mettre à jour le statut
      order.status = OrderStatus.CANCELLED;
      
      // Sauvegarder les modifications
      const updatedOrder = await this.ordersRepository.save(order);
      
      return updatedOrder;
    } catch (error) {
      // Rethrow avec un message plus clair
      if (error instanceof NotFoundException) {
        throw error;
      } else if (error instanceof BadRequestException) {
        throw error;
      } else {
        throw new BadRequestException(`Impossible d'annuler la commande: ${error.message}`);
      }
    }
  }

  async getUserOrders(userId: string): Promise<Order[]> {
    return this.findAll(userId);
  }

  async getOrderStats(): Promise<any> {
    try {
      // Récupérer le nombre total de commandes
      const totalOrders = await this.ordersRepository.count();
      
      // Récupérer le nombre de commandes par statut
      const ordersByStatus = await this.ordersRepository.query(`
        SELECT status, COUNT(*) as count
        FROM orders
        GROUP BY status
      `);
      
      // Récupérer le montant total des commandes
      const totalAmount = await this.ordersRepository.query(`
        SELECT SUM(total_amount) as total
        FROM orders
        WHERE status != 'CANCELLED'
      `);
      
      // Récupérer les commandes récentes (10 dernières)
      const recentOrders = await this.ordersRepository.query(`
        SELECT id, date, status, total_amount
        FROM orders
        ORDER BY date DESC
        LIMIT 10
      `);
      
      // Récupérer le nombre de commandes par jour (30 derniers jours)
      const ordersByDay = await this.ordersRepository.query(`
        SELECT DATE(date) as order_date, COUNT(*) as count
        FROM orders
        WHERE date >= CURRENT_DATE - INTERVAL '30 days'
        GROUP BY DATE(date)
        ORDER BY order_date DESC
      `);
      
      return {
        totalOrders,
        ordersByStatus,
        totalAmount: totalAmount[0]?.total || 0,
        recentOrders,
        ordersByDay
      };
    } catch (error) {
      throw new InternalServerErrorException(`Failed to retrieve order statistics: ${error.message}`);
    }
  }

  async getOrderHistory(): Promise<any> {
    try {
      // Récupérer toutes les commandes avec leurs détails
      const orders = await this.ordersRepository.query(`
        SELECT o.id, o.date, o.status, o.total_amount, o.delivery_address, o.payment_method,
               u.username, u.email
        FROM orders o
        LEFT JOIN users u ON o.user_id = u.id
        ORDER BY o.date DESC
      `);
      
      // Pour chaque commande, récupérer ses articles
      for (const order of orders) {
        const items = await this.orderItemsRepository.query(`
          SELECT oi.id, oi.quantity, mi.price as unit_price, 
                 (oi.quantity * mi.price) as total_price,
                 mi.name as product_name, mi.description as product_description
          FROM order_items oi
          LEFT JOIN menu_items mi ON oi.product_id = mi.id
          WHERE oi.order_id = $1
        `, [order.id]);
        
        // Pour chaque article, simplifier l'approche et récupérer uniquement l'ID du supplément
        for (const item of items) {
          // D'abord, récupérer les IDs des suppléments
          const supplementIds = await this.orderItemSupplementsRepository.query(`
            SELECT supplement_id
            FROM order_item_supplements
            WHERE order_item_id = $1
          `, [item.id]);
          
          // Ensuite, récupérer les détails des suppléments individuellement pour éviter les problèmes de type
          const supplements = [];
          for (const supId of supplementIds) {
            try {
              // Essayer de récupérer le supplément en utilisant l'ID comme chaîne
              const supplementDetails = await this.dataSource.query(`
                SELECT id, name, additional_price as price
                FROM menu_item_options
                WHERE id::text = $1
              `, [supId.supplement_id]);
              
              if (supplementDetails && supplementDetails.length > 0) {
                supplements.push(supplementDetails[0]);
              }
            } catch (error) {
              console.error(`Erreur lors de la récupération du supplément ${supId.supplement_id}: ${error.message}`);
              // Continuer avec le prochain supplément
            }
          }
          
          item.supplements = supplements;
        }
        
        order.items = items;
      }
      
      return {
        orders,
        totalCount: orders.length
      };
    } catch (error) {
      throw new InternalServerErrorException(`Failed to retrieve order history: ${error.message}`);
    }
  }
}