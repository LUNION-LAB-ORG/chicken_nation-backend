import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { MobileMoneyTransaction, MobileMoneyTransactionStatus, MobileMoneyOperator } from '../entities/mobile-money-transaction.entity';
import { MobileMoneyPaymentDto } from '../dto/mobile-money-payment.dto';
import { OrdersService } from '../../orders/services/orders.service';
import { Payment, PaymentMethod, PaymentStatus } from '../entities/payment.entity';
import { Transaction, TransactionStatus, TransactionType } from '../entities/transaction.entity';

@Injectable()
export class MobileMoneyService {
  constructor(
    @InjectRepository(MobileMoneyTransaction)
    private mobileMoneyRepository: Repository<MobileMoneyTransaction>,
    @InjectRepository(Payment)
    private paymentsRepository: Repository<Payment>,
    @InjectRepository(Transaction)
    private transactionsRepository: Repository<Transaction>,
    private ordersService: OrdersService,
    private dataSource: DataSource,
  ) {}

  async findAll(): Promise<MobileMoneyTransaction[]> {
    return this.mobileMoneyRepository.find();
  }

  async findOne(id: string): Promise<MobileMoneyTransaction> {
    const transaction = await this.mobileMoneyRepository.findOne({
      where: { id },
    });

    if (!transaction) {
      throw new NotFoundException(`Mobile Money transaction with ID ${id} not found`);
    }

    return transaction;
  }

  async findByOrderId(orderId: string): Promise<MobileMoneyTransaction[]> {
    return this.mobileMoneyRepository.find({
      where: { orderId },
    });
  }

  async create(userId: string, mobileMoneyPaymentDto: MobileMoneyPaymentDto): Promise<MobileMoneyTransaction> {
    // Vérifier que la commande existe
    const order = await this.ordersService.findOne(mobileMoneyPaymentDto.order_id);

    // Utiliser une transaction pour garantir l'intégrité des données
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Créer le paiement principal
      const payment = new Payment();
      payment.userId = userId;
      payment.orderId = mobileMoneyPaymentDto.order_id;
      payment.amount = mobileMoneyPaymentDto.amount;
      payment.method = PaymentMethod.MOBILE_MONEY;
      payment.status = PaymentStatus.PENDING;
      payment.transactionReference = this.generateTransactionReference();

      const savedPayment = await queryRunner.manager.save(Payment, payment);

      // Créer la transaction générale
      const transaction = new Transaction();
      transaction.paymentId = savedPayment.id;
      transaction.type = TransactionType.PAYMENT;
      transaction.status = TransactionStatus.PENDING;
      transaction.amount = mobileMoneyPaymentDto.amount;
      transaction.providerTransactionId = payment.transactionReference;

      await queryRunner.manager.save(Transaction, transaction);

      // Créer la transaction Mobile Money spécifique
      const mobileMoneyTransaction = new MobileMoneyTransaction();
      mobileMoneyTransaction.orderId = mobileMoneyPaymentDto.order_id;
      mobileMoneyTransaction.amount = mobileMoneyPaymentDto.amount;
      mobileMoneyTransaction.status = MobileMoneyTransactionStatus.PENDING;
      mobileMoneyTransaction.phoneNumber = mobileMoneyPaymentDto.phone_number;
      mobileMoneyTransaction.operator = mobileMoneyPaymentDto.operator as MobileMoneyOperator;
      mobileMoneyTransaction.transactionReference = payment.transactionReference;

      const savedMobileMoneyTransaction = await queryRunner.manager.save(MobileMoneyTransaction, mobileMoneyTransaction);

      await queryRunner.commitTransaction();

      return savedMobileMoneyTransaction;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  async updateStatus(id: string, status: MobileMoneyTransactionStatus, providerResponse?: Record<string, any>): Promise<MobileMoneyTransaction> {
    const mobileMoneyTransaction = await this.findOne(id);

    // Utiliser une transaction pour garantir l'intégrité des données
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Mettre à jour le statut de la transaction Mobile Money
      mobileMoneyTransaction.status = status;
      
      if (providerResponse) {
        mobileMoneyTransaction.providerResponse = providerResponse;
      }

      const savedMobileMoneyTransaction = await queryRunner.manager.save(MobileMoneyTransaction, mobileMoneyTransaction);

      // Trouver le paiement associé à cette commande et mettre à jour son statut
      const payment = await this.paymentsRepository.findOne({
        where: { orderId: mobileMoneyTransaction.orderId, method: PaymentMethod.MOBILE_MONEY },
      });

      if (payment) {
        const paymentStatus = this.mapMobileMoneyStatusToPaymentStatus(status);
        payment.status = paymentStatus;
        
        if (paymentStatus === PaymentStatus.COMPLETED) {
          payment.completedAt = new Date();
        }

        await queryRunner.manager.save(Payment, payment);

        // Créer une nouvelle transaction pour le changement de statut
        const transaction = new Transaction();
        transaction.paymentId = payment.id;
        transaction.type = this.getTransactionTypeFromPaymentStatus(paymentStatus);
        transaction.status = TransactionStatus.COMPLETED;
        transaction.amount = payment.amount;
        transaction.providerTransactionId = mobileMoneyTransaction.transactionReference;
        transaction.metadata = providerResponse;

        await queryRunner.manager.save(Transaction, transaction);
      }

      await queryRunner.commitTransaction();

      return savedMobileMoneyTransaction;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  private generateTransactionReference(): string {
    const timestamp = new Date().getTime();
    const random = Math.floor(Math.random() * 10000);
    return `MM-${timestamp}-${random}`;
  }

  private mapMobileMoneyStatusToPaymentStatus(status: MobileMoneyTransactionStatus): PaymentStatus {
    switch (status) {
      case MobileMoneyTransactionStatus.COMPLETED:
        return PaymentStatus.COMPLETED;
      case MobileMoneyTransactionStatus.FAILED:
        return PaymentStatus.FAILED;
      default:
        return PaymentStatus.PENDING;
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
}
