import { Entity, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn } from 'typeorm';

export enum StatisticPeriod {
  DAILY = 'daily',
  WEEKLY = 'weekly',
  MONTHLY = 'monthly',
  YEARLY = 'yearly',
}

@Entity('sales_statistics')
export class SalesStatistic {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'period_type' })
  periodType: StatisticPeriod;

  @Column({ name: 'period_start' })
  periodStart: Date;

  @Column({ name: 'period_end' })
  periodEnd: Date;

  @Column({ name: 'total_orders', default: 0 })
  totalOrders: number;

  @Column({ name: 'total_sales', type: 'decimal', precision: 10, scale: 2, default: 0 })
  totalSales: number;

  @Column({ name: 'average_order_value', type: 'decimal', precision: 10, scale: 2, default: 0 })
  averageOrderValue: number;

  @Column({ name: 'total_customers', default: 0 })
  totalCustomers: number;

  @Column({ name: 'new_customers', default: 0 })
  newCustomers: number;

  @Column({ name: 'returning_customers', default: 0 })
  returningCustomers: number;

  @Column({ name: 'restaurant_id', nullable: true })
  restaurantId: string;

  @Column({ name: 'category_id', nullable: true })
  categoryId: string;

  @Column({ name: 'product_id', nullable: true })
  productId: string;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, any>;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
