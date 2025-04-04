import { Entity, PrimaryGeneratedColumn, Column, OneToMany } from 'typeorm';
import { RestaurantSchedule } from './restaurant-schedule.entity';
import { RestaurantTable } from './restaurant-table.entity';
import { RestaurantReservationSlot } from './restaurant-reservation-slot.entity';
import { TableReservation } from './table-reservation.entity';
import { MenuItem } from '../../menu/entities/menuItem.entity';

@Entity('restaurants')
export class Restaurant {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar' })
  name: string;

  @Column({ type: 'varchar', nullable: true })
  description: string;

  @Column({ type: 'varchar' })
  address: string;

  @Column({ type: 'varchar' })
  location: string;

  @Column({ type: 'varchar' })
  phone: string;

  @Column({ type: 'varchar', nullable: true })
  email: string;

  @Column({ type: 'boolean', default: true })
  is_open: boolean;

  @Column({ type: 'varchar', nullable: true })
  closing_time: string;

  @Column({ type: 'varchar', nullable: true })
  opening_time: string;

  @Column({ type: 'varchar' })
  delivery_start_time: string;

  @Column({ type: 'varchar', nullable: true })
  delivery_end_time: string;

  @Column({ type: 'varchar', nullable: true })
  image: string;

  @Column({ type: 'float', nullable: true })
  latitude: number;

  @Column({ type: 'float', nullable: true })
  longitude: number;

  @Column({ type: 'int' })
  max_reservation_size: number;

  @Column({ type: 'int' })
  min_reservation_size: number;

  @Column({ type: 'int' })
  reservation_lead_hours: number;

  @Column({ type: 'int' })
  reservation_max_days: number;

  @Column({ type: 'jsonb', nullable: true })
  reservation_settings: Record<string, any>;

  // Relations
  @OneToMany(() => RestaurantSchedule, schedule => schedule.restaurant)
  schedules: RestaurantSchedule[];

  @OneToMany(() => RestaurantTable, table => table.restaurant)
  tables: RestaurantTable[];

  @OneToMany(() => RestaurantReservationSlot, slot => slot.restaurant)
  reservation_slots: RestaurantReservationSlot[];

  @OneToMany(() => TableReservation, reservation => reservation.restaurant)
  reservations: TableReservation[];

  @OneToMany(() => MenuItem, menuItem => menuItem.restaurant)
  menu_items: MenuItem[];
}
