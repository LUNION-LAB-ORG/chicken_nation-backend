import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn } from 'typeorm';
import { Restaurant } from './restaurant.entity';
import { User } from '../../auth/entities/user.entity';

@Entity('table_reservations')
export class TableReservation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id' })
  userId: string;

  @Column({ name: 'restaurant_id' })
  restaurantId: string;

  @Column({ name: 'reservation_date', type: 'date' })
  reservationDate: Date;

  @Column({ name: 'reservation_time', type: 'varchar' })
  reservationTime: string;

  @Column({ name: 'party_size', type: 'int' })
  partySize: number;

  @Column({ type: 'varchar' })
  status: string;

  @Column({ name: 'special_requests', type: 'varchar', nullable: true })
  specialRequests: string;

  @Column({ name: 'created_at', type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  createdAt: Date;

  @ManyToOne(() => User)
  @JoinColumn({ name: 'user_id' })
  user: User;

  @ManyToOne(() => Restaurant, restaurant => restaurant.reservations)
  @JoinColumn({ name: 'restaurant_id' })
  restaurant: Restaurant;
}
