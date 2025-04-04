import { Test, TestingModule } from '@nestjs/testing';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from '../services/payments.service';
import { CreatePaymentDto } from '../dto/create-payment.dto';
import { UpdatePaymentStatusDto } from '../dto/update-payment-status.dto';
import { Payment, PaymentMethod, PaymentStatus } from '../entities/payment.entity';

describe('PaymentsController', () => {
  let controller: PaymentsController;
  let service: PaymentsService;

  beforeEach(async () => {
    const mockPaymentsService = {
      findAll: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      updateStatus: jest.fn(),
      getUserPayments: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PaymentsController],
      providers: [
        {
          provide: PaymentsService,
          useValue: mockPaymentsService,
        },
      ],
    }).compile();

    controller = module.get<PaymentsController>(PaymentsController);
    service = module.get<PaymentsService>(PaymentsService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('findAll', () => {
    it('should return an array of payments', async () => {
      const result = [{ id: '1' }] as Payment[];
      jest.spyOn(service, 'findAll').mockResolvedValue(result);

      expect(await controller.findAll()).toBe(result);
    });
  });

  describe('findOne', () => {
    it('should return a payment by id', async () => {
      const result = { id: '1' } as Payment;
      jest.spyOn(service, 'findOne').mockResolvedValue(result);

      expect(await controller.findOne('1')).toBe(result);
    });
  });

  describe('create', () => {
    it('should create a payment', async () => {
      const createPaymentDto: CreatePaymentDto = {
        order_id: 'order-123',
        method: PaymentMethod.CARD,
        amount: 100,
      };
      const result = { id: '1' } as Payment;
      const req = { user: { userId: 'user-123' } };

      jest.spyOn(service, 'create').mockResolvedValue(result);

      expect(await controller.create(req, createPaymentDto)).toBe(result);
      expect(service.create).toHaveBeenCalledWith('user-123', createPaymentDto);
    });
  });

  describe('updateStatus', () => {
    it('should update payment status', async () => {
      const updateStatusDto: UpdatePaymentStatusDto = {
        status: PaymentStatus.COMPLETED,
      };
      const result = { id: '1', status: PaymentStatus.COMPLETED } as Payment;

      jest.spyOn(service, 'updateStatus').mockResolvedValue(result);

      expect(await controller.updateStatus('1', updateStatusDto)).toBe(result);
      expect(service.updateStatus).toHaveBeenCalledWith('1', updateStatusDto);
    });
  });

  describe('getUserPayments', () => {
    it('should return user payments', async () => {
      const result = [{ id: '1' }] as Payment[];
      const req = { user: { userId: 'user-123' } };

      jest.spyOn(service, 'getUserPayments').mockResolvedValue(result);

      expect(await controller.getUserPayments(req)).toBe(result);
      expect(service.getUserPayments).toHaveBeenCalledWith('user-123');
    });
  });
});