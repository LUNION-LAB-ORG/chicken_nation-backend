import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn } from 'typeorm';
import { Payment } from './payment.entity';

export enum TransactionType {
  PAYMENT = 'payment',
  REFUND = 'refund',
  AUTHORIZATION = 'authorization',
  CAPTURE = 'capture',
  VOID = 'void',
}

export enum TransactionStatus {
  PENDING = 'pending',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

@Entity('transactions')
export class Transaction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'payment_id' })
  paymentId: string;

  @ManyToOne(() => Payment, payment => payment.transactions)
  @JoinColumn({ name: 'payment_id' })
  payment: Payment;

  @Column({
    type: 'enum',
    enum: TransactionType,
  })
  type: TransactionType;

  @Column({
    type: 'enum',
    enum: TransactionStatus,
    default: TransactionStatus.PENDING,
  })
  status: TransactionStatus;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  amount: number;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  createdAt: Date;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, any>;

  @Column({ nullable: true })
  providerTransactionId: string;

  @Column({ nullable: true })
  errorMessage: string;
}