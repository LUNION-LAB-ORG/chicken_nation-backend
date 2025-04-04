import { Test, TestingModule } from '@nestjs/testing';
import { MobileMoneyController } from './mobile-money.controller';
import { MobileMoneyService } from '../services/mobile-money.service';
import { MobileMoneyPaymentDto } from '../dto/mobile-money-payment.dto';
import { MobileMoneyTransaction, MobileMoneyTransactionStatus, MobileMoneyOperator } from '../entities/mobile-money-transaction.entity';

describe('MobileMoneyController', () => {
  let controller: MobileMoneyController;
  let service: MobileMoneyService;

  beforeEach(async () => {
    const mockMobileMoneyService = {
      findAll: jest.fn(),
      findOne: jest.fn(),
      findByOrderId: jest.fn(),
      create: jest.fn(),
      updateStatus: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [MobileMoneyController],
      providers: [
        {
          provide: MobileMoneyService,
          useValue: mockMobileMoneyService,
        },
      ],
    }).compile();

    controller = module.get<MobileMoneyController>(MobileMoneyController);
    service = module.get<MobileMoneyService>(MobileMoneyService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('findAll', () => {
    it('should return an array of mobile money transactions', async () => {
      const result = [{
        id: 'mm-123',
        orderId: 'order-123',
        amount: 100,
        status: MobileMoneyTransactionStatus.PENDING,
        phoneNumber: '123456789',
        operator: MobileMoneyOperator.ORANGE,
        paymentMethod: 'mobile_money',
        transactionReference: 'MM-123456789',
        createdAt: new Date(),
        updatedAt: new Date()
      }];
      
      jest.spyOn(service, 'findAll').mockResolvedValue(result as MobileMoneyTransaction[]);

      expect(await controller.findAll()).toBe(result);
    });
  });

  describe('findOne', () => {
    it('should return a mobile money transaction by id', async () => {
      const result = {
        id: 'mm-123',
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
      
      jest.spyOn(service, 'findOne').mockResolvedValue(result as MobileMoneyTransaction);

      expect(await controller.findOne('mm-123')).toBe(result);
    });
  });

  describe('findByOrderId', () => {
    it('should return mobile money transactions for an order', async () => {
      const result = [{
        id: 'mm-123',
        orderId: 'order-123',
        amount: 100,
        status: MobileMoneyTransactionStatus.PENDING,
        phoneNumber: '123456789',
        operator: MobileMoneyOperator.ORANGE,
        paymentMethod: 'mobile_money',
        transactionReference: 'MM-123456789',
        createdAt: new Date(),
        updatedAt: new Date()
      }];
      
      jest.spyOn(service, 'findByOrderId').mockResolvedValue(result as MobileMoneyTransaction[]);

      expect(await controller.findByOrderId('order-123')).toBe(result);
    });
  });

  describe('create', () => {
    it('should create a mobile money transaction', async () => {
      const dto: MobileMoneyPaymentDto = {
        order_id: 'order-123',
        amount: 100,
        phone_number: '123456789',
        operator: 'orange',
      };
      
      const result = {
        id: 'mm-123',
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
      
      const req = { user: { userId: 'user-123' } };

      jest.spyOn(service, 'create').mockResolvedValue(result as MobileMoneyTransaction);

      expect(await controller.create(req, dto)).toBe(result);
      expect(service.create).toHaveBeenCalledWith('user-123', dto);
    });
  });

  describe('updateStatus', () => {
    it('should update mobile money transaction status', async () => {
      const updateStatusDto = {
        status: MobileMoneyTransactionStatus.COMPLETED,
        providerResponse: { reference: 'provider-ref-123', status: 'success' },
      };
      
      const result = {
        id: 'mm-123',
        orderId: 'order-123',
        amount: 100,
        status: MobileMoneyTransactionStatus.COMPLETED,
        phoneNumber: '123456789',
        operator: MobileMoneyOperator.ORANGE,
        providerResponse: updateStatusDto.providerResponse,
        paymentMethod: 'mobile_money',
        transactionReference: 'MM-123456789',
        createdAt: new Date(),
        updatedAt: new Date()
      };

      jest.spyOn(service, 'updateStatus').mockResolvedValue(result as MobileMoneyTransaction);

      expect(await controller.updateStatus('mm-123', updateStatusDto)).toBe(result);
      expect(service.updateStatus).toHaveBeenCalledWith(
        'mm-123',
        updateStatusDto.status,
        updateStatusDto.providerResponse
      );
    });
  });
});
