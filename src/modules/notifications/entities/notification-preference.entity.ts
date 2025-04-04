import { Entity, Column, PrimaryColumn, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity('notification_settings')
export class NotificationPreference {
  @PrimaryColumn({ name: 'user_id' })
  userId: string;

  @Column({ type: 'jsonb', name: 'order_updates' })
  orderUpdates: Record<string, any>;

  @Column({ type: 'jsonb', name: 'promotions' })
  promotions: Record<string, any>;

  @Column({ type: 'jsonb', name: 'newsletter' })
  newsletter: Record<string, any>;

  @Column({ type: 'jsonb', name: 'push_notifications' })
  pushNotifications: Record<string, any>;
}
