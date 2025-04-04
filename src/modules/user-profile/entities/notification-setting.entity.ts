import { Entity, PrimaryGeneratedColumn, Column, OneToOne, JoinColumn } from 'typeorm';
import { User } from '../../auth/entities/user.entity';

@Entity('notification_settings')
export class NotificationSetting {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'jsonb', default: {} })
  email_preferences: Record<string, boolean>;

  @Column({ type: 'jsonb', default: {} })
  push_preferences: Record<string, boolean>;

  @Column({ type: 'jsonb', default: {} })
  sms_preferences: Record<string, boolean>;

  @Column({ name: 'user_id', unique: true })
  userId: string;

  @OneToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;
}
