import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { PaymentsService } from './payments.service';
import { Payment, PaymentStatus } from '../entities/payment.entity';
import { Transaction } from '../entities/transaction.entity';
import { OrdersService } from '../../orders/services/orders.service';
import { CreatePaymentDto } from '../dto/create-payment.dto';
import { UpdatePaymentStatusDto } from '../dto/update-payment-status.dto';
import { NotFoundException, BadRequestException } from '@nestjs/common';

type MockRepository<T = any> = Partial<Record<keyof Repository<T>, jest.Mock>>;
const createMockRepository = <T = any>(): MockRepository<T> => ({
  findOne: jest.fn(),
  find: jest.fn(),
  create: jest.fn(),
  save: jest.fn(),
  createQueryBuilder: jest.fn(() => ({
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([]),
  })),
});

describe('PaymentsService', () => {
  let service: PaymentsService;
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
        save: jest.fn(),
      },
    };

    dataSource = {
      createQueryRunner: jest.fn().mockReturnValue(queryRunnerMock),
    };

    ordersService = {
      findOne: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentsService,
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

    service = module.get<PaymentsService>(PaymentsService);
    paymentRepository = module.get<MockRepository<Payment>>(getRepositoryToken(Payment));
    transactionRepository = module.get<MockRepository<Transaction>>(getRepositoryToken(Transaction));
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('findOne', () => {
    it('should return a payment if found', async () => {
      const mockPayment = { id: '1', transactions: [] };
      paymentRepository.findOne.mockResolvedValue(mockPayment);

      const result = await service.findOne('1');
      expect(result).toEqual(mockPayment);
      expect(paymentRepository.findOne).toHaveBeenCalledWith({
        where: { id: '1' },
        relations: ['transactions'],
      });
    });

    it('should throw NotFoundException if payment not found', async () => {
      paymentRepository.findOne.mockResolvedValue(null);

      await expect(service.findOne('1')).rejects.toThrow(NotFoundException);
    });
  });

  describe('updateStatus', () => {
    it('should update payment status', async () => {
      const mockPayment = {
        id: '1',
        status: PaymentStatus.PENDING,
        amount: 100,
        transactions: [],
      };
      const updateDto: UpdatePaymentStatusDto = {
        status: PaymentStatus.COMPLETED,
      };

      paymentRepository.findOne.mockResolvedValue(mockPayment);
      service.findOne = jest.fn().mockResolvedValue(mockPayment);

      await service.updateStatus('1', updateDto);

      // Vérifier que la transaction a été démarrée
      expect(dataSource.createQueryRunner).toHaveBeenCalled();
      const queryRunner = await dataSource.createQueryRunner();
      expect(queryRunner.startTransaction).toHaveBeenCalled();

      // Vérifier que les données ont été sauvegardées
      expect(queryRunner.manager.save).toHaveBeenCalledTimes(2);

      // Vérifier que la transaction a été validée
      expect(queryRunner.commitTransaction).toHaveBeenCalled();
      expect(queryRunner.release).toHaveBeenCalled();

      expect(mockPayment.status).toBe(PaymentStatus.COMPLETED);
            }); }); });