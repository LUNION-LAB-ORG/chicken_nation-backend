import { Test, TestingModule } from '@nestjs/testing';
import { OrdersController } from './orders.controller';
import { OrdersService } from '../services/orders.service';
import { Order, OrderStatus, PaymentMethod } from '../entities/order.entity';
import { CreateOrderDto } from '../dto/create-order.dto';
import { UpdateOrderStatusDto } from '../dto/update-order-status.dto';
import { NotFoundException, BadRequestException } from '@nestjs/common';

describe('OrdersController', () => {
  let controller: OrdersController;
  let service: OrdersService;

  const mockOrdersService = {
    findAll: jest.fn(),
    findOne: jest.fn(),
    create: jest.fn(),
    updateStatus: jest.fn(),
    cancel: jest.fn(),
    getUserOrders: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [OrdersController],
      providers: [
        {
          provide: OrdersService,
          useValue: mockOrdersService,
        },
      ],
    }).compile();

    controller = module.get<OrdersController>(OrdersController);
    service = module.get<OrdersService>(OrdersService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('findAll', () => {
    it('should return an array of orders', async () => {
      const expectedOrders = [new Order()];
      mockOrdersService.findAll.mockResolvedValue(expectedOrders);

      const result = await controller.findAll();
      expect(result).toEqual(expectedOrders);
      expect(mockOrdersService.findAll).toHaveBeenCalled();
    });
  });

  describe('findOne', () => {
    it('should return a single order', async () => {
      const orderId = '1';
      const expectedOrder = new Order();
      mockOrdersService.findOne.mockResolvedValue(expectedOrder);

      const result = await controller.findOne(orderId);
      expect(result).toEqual(expectedOrder);
      expect(mockOrdersService.findOne).toHaveBeenCalledWith(orderId);
    });
  });

  describe('create', () => {
    it('should create a new order', async () => {
      const userId = 'user-123';
      const createOrderDto: CreateOrderDto = {
        // La référence au restaurant a été supprimée
        payment_method: PaymentMethod.CARD,
        items: [
          {
            product_id: 'product-123',
            quantity: 2,
            supplement_ids: ['supplement-123'],
          },
        ],
      };
      const expectedOrder = new Order();
      mockOrdersService.create.mockResolvedValue(expectedOrder);

      const req = { user: { userId } };
      const result = await controller.create(req, createOrderDto);

      expect(result).toEqual(expectedOrder);
      expect(mockOrdersService.create).toHaveBeenCalledWith(userId, createOrderDto);
    });
  });

  describe('updateStatus', () => {
    it('should update order status', async () => {
      const orderId = '1';
      const updateOrderStatusDto: UpdateOrderStatusDto = {
        status: OrderStatus.CONFIRMED,
      };
      const expectedOrder = new Order();
      expectedOrder.status = OrderStatus.CONFIRMED;
      mockOrdersService.updateStatus.mockResolvedValue(expectedOrder);

      const result = await controller.updateStatus(orderId, updateOrderStatusDto);

      expect(result).toEqual(expectedOrder);
      expect(mockOrdersService.updateStatus).toHaveBeenCalledWith(orderId, updateOrderStatusDto);
    });
  });

  describe('cancelOrder', () => {
    it('should cancel an order', async () => {
      const orderId = '1';
      const expectedOrder = new Order();
      expectedOrder.status = OrderStatus.CANCELLED;
      mockOrdersService.cancel.mockResolvedValue(expectedOrder);

      const result = await controller.cancelOrder(orderId);

      expect(result).toEqual(expectedOrder);
      expect(mockOrdersService.cancel).toHaveBeenCalledWith(orderId);
    });
  });

  describe('getUserOrders', () => {
    it('should return orders for the current user', async () => {
      const userId = 'user-123';
      const expectedOrders = [new Order()];
      mockOrdersService.getUserOrders.mockResolvedValue(expectedOrders);

      const req = { user: { userId } };
      const result = await controller.getUserOrders(req);

      expect(result).toEqual(expectedOrders);
      expect(mockOrdersService.getUserOrders).toHaveBeenCalledWith(userId);
    });
  });
});