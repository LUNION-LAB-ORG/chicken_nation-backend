import { Entity, Column, ManyToOne, JoinColumn, PrimaryColumn } from 'typeorm';
import { Restaurant } from './restaurant.entity';

@Entity('restaurant_tables')
export class RestaurantTable {
  @PrimaryColumn({ name: 'restaurant_id' })
  restaurantId: string;

  @PrimaryColumn()
  capacity: number;

  @PrimaryColumn()
  type: string;

  @Column({ type: 'int' })
  quantity: number;

  @ManyToOne(() => Restaurant, restaurant => restaurant.tables, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'restaurant_id' })
  restaurant: Restaurant;
}
