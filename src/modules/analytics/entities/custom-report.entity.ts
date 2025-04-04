import { Entity, Column, PrimaryGeneratedColumn, ManyToOne, JoinColumn, CreateDateColumn, UpdateDateColumn } from 'typeorm';
import { User } from '../../auth/entities/user.entity';

export enum ReportType {
  SALES = 'sales',
  ORDERS = 'orders',
  CUSTOMERS = 'customers',
  PRODUCTS = 'products',
  RESTAURANTS = 'restaurants',
  CUSTOM = 'custom',
}

export enum ReportFormat {
  CSV = 'csv',
  PDF = 'pdf',
  JSON = 'json',
  EXCEL = 'excel',
}

@Entity('custom_reports')
export class CustomReport {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ nullable: true })
  description: string;

  @Column({ name: 'user_id' })
  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({
    type: 'enum',
    enum: ReportType,
    default: ReportType.SALES,
  })
  reportType: ReportType;

  @Column({
    type: 'enum',
    enum: ReportFormat,
    default: ReportFormat.CSV,
  })
  format: ReportFormat;

  @Column({ type: 'jsonb' })
  filters: Record<string, any>;

  @Column({ type: 'jsonb' })
  columns: string[];

  @Column({ name: 'is_scheduled', default: false })
  isScheduled: boolean;

  @Column({ name: 'schedule_frequency', nullable: true })
  scheduleFrequency: string;

  @Column({ name: 'last_run_at', nullable: true })
  lastRunAt: Date;

  @Column({ name: 'last_run_status', nullable: true })
  lastRunStatus: string;

  @Column({ name: 'file_path', nullable: true })
  filePath: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
