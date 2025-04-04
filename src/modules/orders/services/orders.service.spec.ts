import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { OrdersService } from './orders.service';
import { Order, OrderStatus, PaymentMethod } from '../entities/order.entity';
import { OrderItem } from '../entities/orderItem.entity';
import { OrderItemSupplement } from '../entities/orderItemSupplement.entity';
import { MenuItem } from '../../menu/entities/menuItem.entity';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { CreateOrderDto, CreateOrderItemDto } from '../dto/create-order.dto';

type MockRepository<T = any> = Partial<Record<keyof Repository<T>, jest.Mock>>;
const createMockRepository = <T = any>(): MockRepository<T> => ({
  findOne: jest.fn(),
  find: jest.fn(),
  createQueryBuilder: jest.fn(() => ({
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([]),
  })),
  save: jest.fn(),
  query: jest.fn(), 
});

describe('OrdersService', () => {
  let service: OrdersService;
  let orderRepository: MockRepository<Order>;
  let orderItemRepository: MockRepository<OrderItem>;
  let orderItemSupplementRepository: MockRepository<OrderItemSupplement>;
  let menuItemRepository: MockRepository<MenuItem>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        OrdersService,
        {
          provide: getRepositoryToken(Order),
          useValue: createMockRepository(),
        },
        {
          provide: getRepositoryToken(OrderItem),
          useValue: createMockRepository(),
        },
        {
          provide: getRepositoryToken(OrderItemSupplement),
          useValue: createMockRepository(),
        },
        {
          provide: getRepositoryToken(MenuItem),
          useValue: createMockRepository(),
        },
        {
          provide: DataSource,
          useValue: {
            createQueryRunner: jest.fn().mockReturnValue({
              connect: jest.fn(),
              startTransaction: jest.fn(),
              manager: {
                save: jest.fn(),
              },
              commitTransaction: jest.fn(),
              rollbackTransaction: jest.fn(),
              release: jest.fn(),
            }),
          },
        },
      ],
    }).compile();

    service = module.get<OrdersService>(OrdersService);
    orderRepository = module.get<MockRepository<Order>>(getRepositoryToken(Order));
    orderItemRepository = module.get<MockRepository<OrderItem>>(getRepositoryToken(OrderItem));
    orderItemSupplementRepository = module.get<MockRepository<OrderItemSupplement>>(getRepositoryToken(OrderItemSupplement));
    menuItemRepository = module.get<MockRepository<MenuItem>>(getRepositoryToken(MenuItem));
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('findOne', () => {
    it('should return an order if it exists', async () => {
      const orderId = '1';
      const mockOrder = { id: orderId, status: OrderStatus.PENDING };
      const mockItems = [{ id: '1', order_id: orderId, product_id: 1, quantity: 2 }];
      const mockProduct = { id: 1, name: 'Test Product', price: 10 };
      const mockSupplements = [{ order_item_id: '1', supplement_id: '1' }];

      orderRepository.query.mockResolvedValueOnce([mockOrder]); 
      orderItemRepository.query.mockResolvedValueOnce(mockItems); 
      menuItemRepository.query.mockResolvedValueOnce([mockProduct]); 
      orderItemSupplementRepository.query.mockResolvedValueOnce(mockSupplements); 

      const result = await service.findOne(orderId);
      
      expect(result).toEqual({
        ...mockOrder,
        items: [{
          ...mockItems[0],
          product: mockProduct,
          supplements: mockSupplements
        }]
      });
      
      expect(orderRepository.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT * FROM orders WHERE id = $1'),
        [orderId]
      );
    });

    it('should throw NotFoundException if order does not exist', async () => {
      const orderId = '1';
      orderRepository.query.mockResolvedValueOnce([]);

      await expect(service.findOne(orderId)).rejects.toThrow(NotFoundException);
      expect(orderRepository.query).toHaveBeenCalledWith(
        expect.stringContaining('SELECT * FROM orders WHERE id = $1'),
        [orderId]
      );
    });
  });

  describe('updateStatus', () => {
    it('should update order status if transition is valid', async () => {
      const orderId = '1';
      const mockOrder = { 
        id: orderId, 
        status: OrderStatus.PENDING,
        items: []
      };
      
      orderRepository.query.mockResolvedValueOnce([mockOrder]); 
      orderItemRepository.query.mockResolvedValueOnce([]); 
      
      orderRepository.save.mockResolvedValueOnce({
        ...mockOrder,
        status: OrderStatus.CONFIRMED
      });

      const updateDto = { status: OrderStatus.CONFIRMED };
      const result = await service.updateStatus(orderId, updateDto);
      
      expect(result.status).toEqual(OrderStatus.CONFIRMED);
      expect(orderRepository.save).toHaveBeenCalled();
    });

    it('should throw BadRequestException if status transition is invalid', async () => {
      const orderId = '1';
      const mockOrder = { 
        id: orderId, 
        status: OrderStatus.DELIVERED,
        items: []
      };
      
      orderRepository.query.mockResolvedValueOnce([mockOrder]); 
      orderItemRepository.query.mockResolvedValueOnce([]); 
      
      const updateDto = { status: OrderStatus.PREPARING };
      
      await expect(service.updateStatus(orderId, updateDto)).rejects.toThrow(BadRequestException);
      expect(orderRepository.save).not.toHaveBeenCalled();
    });
  });
});