import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, CreateDateColumn, UpdateDateColumn } from 'typeorm';
import { Payment } from './payment.entity';

export enum MobileMoneyOperator {
  ORANGE = 'orange',
  MTN = 'mtn',
  MOOV = 'moov',
  WAVE = 'wave',
  OTHER = 'other',
}

export enum MobileMoneyTransactionStatus {
  PENDING = 'pending',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

@Entity('payment_transactions')
export class MobileMoneyTransaction {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'order_id', type: 'uuid' })
  orderId: string;

  @Column({
    type: 'enum',
    enum: ['cash', 'card', 'mobile_money'],
    name: 'payment_method',
    default: 'mobile_money'
  })
  paymentMethod: string;

  @Column({ type: 'decimal', precision: 10, scale: 2 })
  amount: number;

  @Column({
    type: 'enum',
    enum: MobileMoneyTransactionStatus,
    default: MobileMoneyTransactionStatus.PENDING
  })
  status: MobileMoneyTransactionStatus;

  @Column({ name: 'transaction_reference', nullable: true })
  transactionReference: string;

  @Column({ name: 'provider_response', type: 'jsonb', nullable: true })
  providerResponse: Record<string, any>;

  @Column({ name: 'phone_number', nullable: false })
  phoneNumber: string;

  @Column({
    type: 'enum',
    enum: MobileMoneyOperator,
    default: MobileMoneyOperator.OTHER
  })
  operator: MobileMoneyOperator;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
