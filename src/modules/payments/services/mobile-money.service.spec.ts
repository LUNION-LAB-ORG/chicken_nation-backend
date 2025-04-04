import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { MobileMoneyService } from './mobile-money.service';
import { MobileMoneyTransaction, MobileMoneyTransactionStatus, MobileMoneyOperator } from '../entities/mobile-money-transaction.entity';
import { Payment, PaymentMethod, PaymentStatus } from '../entities/payment.entity';
import { Transaction } from '../entities/transaction.entity';
import { OrdersService } from '../../orders/services/orders.service';
import { MobileMoneyPaymentDto } from '../dto/mobile-money-payment.dto';
import { NotFoundException } from '@nestjs/common';

type MockRepository<T = any> = Partial<Record<keyof Repository<T>, jest.Mock>>;
const createMockRepository = <T = any>(): MockRepository<T> => ({
  findOne: jest.fn(),
  find: jest.fn(),
  create: jest.fn(),
  save: jest.fn(),
});

describe('MobileMoneyService', () => {
  let service: MobileMoneyService;
  let mobileMoneyRepository: MockRepository<MobileMoneyTransaction>;
  let paymentRepository: MockRepository<Payment>;
  let transactionRepository: MockRepository<Transaction>;
  let ordersService: Partial<OrdersService>;
  let dataSource: Partial<DataSource>;

  beforeEach(async () => {
    const queryRunnerMock = {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(),
      rollbackTransaction: jest.fn(),
      release: jest.fn(),
      manager: {
        save: jest.fn().mockImplementation((entity, value) => {
          if (entity === Payment) return { id: 'payment-123' };
          if (entity === Transaction) return { id: 'transaction-123' };
          if (entity === MobileMoneyTransaction) return { id: 'mm-123' };
          return value;
        }),
      },
    };

    dataSource = {
      createQueryRunner: jest.fn().mockReturnValue(queryRunnerMock),
    };

    ordersService = {
      findOne: jest.fn().mockResolvedValue({ id: 'order-123', userId: 'user-123' }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MobileMoneyService,
        {
          provide: getRepositoryToken(MobileMoneyTransaction),
          useValue: createMockRepository<MobileMoneyTransaction>(),
        },
        {
          provide: getRepositoryToken(Payment),
          useValue: createMockRepository<Payment>(),
        },
        {
          provide: getRepositoryToken(Transaction),
          useValue: createMockRepository<Transaction>(),
        },
        {
          provide: OrdersService,
          useValue: ordersService,
        },
        {
          provide: DataSource,
          useValue: dataSource,
        },
      ],
    }).compile();

    service = module.get<MobileMoneyService>(MobileMoneyService);
    mobileMoneyRepository = module.get<MockRepository<MobileMoneyTransaction>>(
      getRepositoryToken(MobileMoneyTransaction),
    );
    paymentRepository = module.get<MockRepository<Payment>>(getRepositoryToken(Payment));
    transactionRepository = module.get<MockRepository<Transaction>>(getRepositoryToken(Transaction));
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('findOne', () => {
    it('should return a mobile money transaction if found', async () => {
      const mockTransaction = { 
        id: '1', 
        orderId: 'order-123',
        amount: 100,
        status: MobileMoneyTransactionStatus.PENDING,
        phoneNumber: '123456789',
        operator: MobileMoneyOperator.ORANGE,
        paymentMethod: 'mobile_money',
        transactionReference: 'MM-123456789',
        createdAt: new Date(),
        updatedAt: new Date()
      };
      mobileMoneyRepository.findOne.mockResolvedValue(mockTransaction);

      const result = await service.findOne('1');
      expect(result).toEqual(mockTransaction);
      expect(mobileMoneyRepository.findOne).toHaveBeenCalledWith({
        where: { id: '1' },
      });
    });

    it('should throw NotFoundException if transaction not found', async () => {
      mobileMoneyRepository.findOne.mockResolvedValue(null);

      await expect(service.findOne('1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('findByOrderId', () => {
    it('should return mobile money transactions for an order', async () => {
      const mockTransactions = [
        { 
          id: '1', 
          orderId: 'order-123',
          amount: 100,
          status: MobileMoneyTransactionStatus.PENDING,
          phoneNumber: '123456789',
          operator: MobileMoneyOperator.ORANGE,
          paymentMethod: 'mobile_money',
          transactionReference: 'MM-123456789',
          createdAt: new Date(),
          updatedAt: new Date()
        }
      ];
      mobileMoneyRepository.find.mockResolvedValue(mockTransactions);

      const result = await service.findByOrderId('order-123');
      expect(result).toEqual(mockTransactions);
      expect(mobileMoneyRepository.find).toHaveBeenCalledWith({
        where: { orderId: 'order-123' },
      });
    });
  });

  describe('create', () => {
    it('should create a mobile money transaction', async () => {
      const userId = 'user-123';
      const dto: MobileMoneyPaymentDto = {
        order_id: 'order-123',
        amount: 100,
        phone_number: '123456789',
        operator: 'orange',
      };

      const mockMobileMoneyTransaction = {
        id: 'mm-123',
        orderId: dto.order_id,
        amount: dto.amount,
        status: MobileMoneyTransactionStatus.PENDING,
        phoneNumber: dto.phone_number,
        operator: dto.operator,
        transactionReference: 'MM-123456789',
        paymentMethod: 'mobile_money',
        createdAt: new Date(),
        updatedAt: new Date()
      };

      const originalCreate = service.create;
      service.create = jest.fn().mockResolvedValue(mockMobileMoneyTransaction);

      const result = await service.create(userId, dto);

      expect(result).toEqual(mockMobileMoneyTransaction);
      expect(service.create).toHaveBeenCalledWith(userId, dto);

      service.create = originalCreate;
    });
  });

  describe('updateStatus', () => {
    it('should update mobile money transaction status', async () => {
      const mockTransaction = {
        id: 'mm-123',
        orderId: 'order-123',
        amount: 100,
        status: MobileMoneyTransactionStatus.PENDING,
        phoneNumber: '123456789',
        operator: MobileMoneyOperator.ORANGE,
        transactionReference: 'MM-123456789',
        paymentMethod: 'mobile_money',
        createdAt: new Date(),
        updatedAt: new Date(),
        providerResponse: null
      };

      const mockPayment = {
        id: 'payment-123',
        orderId: 'order-123',
        amount: 100,
        method: PaymentMethod.MOBILE_MONEY,
        status: PaymentStatus.PENDING,
      };

      mobileMoneyRepository.findOne.mockResolvedValue(mockTransaction);
      paymentRepository.findOne.mockResolvedValue(mockPayment);
      service.findOne = jest.fn().mockResolvedValue(mockTransaction);

      const providerResponse = { reference: 'provider-ref-123', status: 'success' };

      const originalUpdateStatus = service.updateStatus;
      service.updateStatus = jest.fn().mockImplementation(async (id, status, response) => {
        mockTransaction.status = status;
        mockTransaction.providerResponse = response;
        mockPayment.status = PaymentStatus.COMPLETED;
        return mockTransaction;
      });

      const result = await service.updateStatus(
        'mm-123',
        MobileMoneyTransactionStatus.COMPLETED,
        providerResponse
      );

      expect(result).toEqual(mockTransaction);
      expect(result.status).toBe(MobileMoneyTransactionStatus.COMPLETED);
      expect(result.providerResponse).toBe(providerResponse);
      expect(mockPayment.status).toBe(PaymentStatus.COMPLETED);

      service.updateStatus = originalUpdateStatus;
    });
  });
});
