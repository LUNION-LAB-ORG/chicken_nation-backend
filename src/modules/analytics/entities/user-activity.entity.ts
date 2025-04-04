import { Entity, Column, PrimaryGeneratedColumn, ManyToOne, JoinColumn, CreateDateColumn } from 'typeorm';
import { User } from '../../auth/entities/user.entity';

export enum ActivityType {
  LOGIN = 'login',
  LOGOUT = 'logout',
  VIEW_PRODUCT = 'view_product',
  ADD_TO_CART = 'add_to_cart',
  REMOVE_FROM_CART = 'remove_from_cart',
  PLACE_ORDER = 'place_order',
  CANCEL_ORDER = 'cancel_order',
  MAKE_RESERVATION = 'make_reservation',
  CANCEL_RESERVATION = 'cancel_reservation',
  SEARCH = 'search',
  RATE_PRODUCT = 'rate_product',
  PAYMENT = 'payment',
}

@Entity('user_activities')
export class UserActivity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id' })
  userId: string;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({
    type: 'enum',
    enum: ActivityType,
    default: ActivityType.VIEW_PRODUCT,
  })
  activityType: ActivityType;

  @Column({ nullable: true })
  resourceId: string;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, any>;

  @Column({ nullable: true })
  ipAddress: string;

  @Column({ nullable: true })
  userAgent: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
