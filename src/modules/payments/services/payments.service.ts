import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Payment, PaymentStatus } from '../entities/payment.entity';
import { Transaction, TransactionStatus, TransactionType } from '../entities/transaction.entity';
import { CreatePaymentDto } from '../dto/create-payment.dto';
import { UpdatePaymentStatusDto } from '../dto/update-payment-status.dto';
import { OrdersService } from '../../orders/services/orders.service';

@Injectable()
export class PaymentsService {
  constructor(
    @InjectRepository(Payment)
    private paymentsRepository: Repository<Payment>,
    @InjectRepository(Transaction)
    private transactionsRepository: Repository<Transaction>,
    private ordersService: OrdersService,
    private dataSource: DataSource,
  ) {}

  async findAll(userId?: string): Promise<Payment[]> {
    const queryBuilder = this.paymentsRepository.createQueryBuilder('payment')
      .leftJoinAndSelect('payment.transactions', 'transactions');

    if (userId) {
      queryBuilder.where('payment.userId = :userId', { userId });
    }

    return queryBuilder.getMany();
  }

  async findOne(id: string): Promise<Payment> {
    const payment = await this.paymentsRepository.findOne({
      where: { id },
      relations: ['transactions'],
    });

    if (!payment) {
      throw new NotFoundException(`Payment with ID ${id} not found`);
    }

    return payment;
  }

  async create(userId: string, createPaymentDto: CreatePaymentDto): Promise<Payment> {
    // Vérifier que la commande existe
    const order = await this.ordersService.findOne(createPaymentDto.order_id);

    // Utiliser une transaction pour garantir l'intégrité des données
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Créer le paiement
      const payment = new Payment();
      payment.userId = userId;
      payment.orderId = createPaymentDto.order_id;
      payment.amount = createPaymentDto.amount;
      payment.method = createPaymentDto.method;
      payment.status = PaymentStatus.PENDING;
      payment.transactionReference = createPaymentDto.transaction_reference;

      const savedPayment = await queryRunner.manager.save(Payment, payment);

      // Créer la transaction initiale
      const transaction = new Transaction();
      transaction.paymentId = savedPayment.id;
      transaction.type = TransactionType.PAYMENT;
      transaction.status = TransactionStatus.PENDING;
      transaction.amount = createPaymentDto.amount;
      transaction.providerTransactionId = createPaymentDto.transaction_reference;

      await queryRunner.manager.save(Transaction, transaction);

      await queryRunner.commitTransaction();

      return this.findOne(savedPayment.id);
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async updateStatus(id: string, updatePaymentStatusDto: UpdatePaymentStatusDto): Promise<Payment> {
    const payment = await this.findOne(id);

    // Utiliser une transaction pour garantir l'intégrité des données
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Mettre à jour le statut du paiement
      payment.status = updatePaymentStatusDto.status;
      
      if (updatePaymentStatusDto.status === PaymentStatus.COMPLETED) {
        payment.completedAt = new Date();
      }

      if (updatePaymentStatusDto.transactionReference) {
        payment.transactionReference = updatePaymentStatusDto.transactionReference;
      }

      await queryRunner.manager.save(Payment, payment);

      // Créer une nouvelle transaction pour le changement de statut
      const transaction = new Transaction();
      transaction.paymentId = payment.id;
      transaction.type = this.getTransactionTypeFromPaymentStatus(updatePaymentStatusDto.status);
      transaction.status = TransactionStatus.COMPLETED;
      transaction.amount = payment.amount;
      transaction.providerTransactionId = updatePaymentStatusDto.transactionReference;

      await queryRunner.manager.save(Transaction, transaction);

      await queryRunner.commitTransaction();

      return this.findOne(id);
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  private getTransactionTypeFromPaymentStatus(status: PaymentStatus): TransactionType {
    switch (status) {
      case PaymentStatus.COMPLETED:
        return TransactionType.CAPTURE;
      case PaymentStatus.REFUNDED:
        return TransactionType.REFUND;
      case PaymentStatus.FAILED:
        return TransactionType.VOID;
      default:
        return TransactionType.PAYMENT;
    }
  }

  async getUserPayments(userId: string): Promise<Payment[]> {
    return this.findAll(userId);
  }
}