import { Entity, Column, ManyToOne, JoinColumn, PrimaryColumn } from 'typeorm';
import { Restaurant } from './restaurant.entity';

@Entity('restaurant_schedules')
export class RestaurantSchedule {
  @PrimaryColumn({ name: 'restaurant_id' })
  restaurantId: string;

  @PrimaryColumn()
  day: string;

  @Column({ type: 'varchar' })
  opening_time: string;

  @Column({ type: 'varchar' })
  closing_time: string;

  @Column({ type: 'boolean', default: false })
  is_closed: boolean;

  @ManyToOne(() => Restaurant, restaurant => restaurant.schedules, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'restaurant_id' })
  restaurant: Restaurant;
}
