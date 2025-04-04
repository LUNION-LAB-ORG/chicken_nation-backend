import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn } from 'typeorm';
import { User } from '../../auth/entities/user.entity';

@Entity('user_addresses')
export class UserAddress {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255 })
  name: string;

  @Column({ type: 'varchar', length: 255 })
  address: string;

  @Column({ type: 'text', nullable: true })
  details: string;

  @Column({ type: 'decimal', precision: 10, scale: 7, nullable: true, name: 'latitude' })
  latitude: number;

  @Column({ type: 'decimal', precision: 10, scale: 7, nullable: true, name: 'longitude' })
  longitude: number;

  @Column({ type: 'boolean', default: false, name: 'is_default' })
  isDefault: boolean;

  @Column({ name: 'user_id' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;
}
