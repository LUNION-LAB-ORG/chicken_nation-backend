import { Entity, ManyToOne, JoinColumn, PrimaryColumn } from 'typeorm';
import { Restaurant } from './restaurant.entity';

@Entity('restaurant_reservation_slots')
export class RestaurantReservationSlot {
  @PrimaryColumn({ name: 'restaurant_id' })
  restaurantId: string;

  @PrimaryColumn({ name: 'time_slot' })
  timeSlot: string;

  @ManyToOne(() => Restaurant, restaurant => restaurant.reservation_slots, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'restaurant_id' })
  restaurant: Restaurant;
}
