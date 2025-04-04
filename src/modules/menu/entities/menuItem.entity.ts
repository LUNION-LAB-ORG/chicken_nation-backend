import { Entity, Column, PrimaryGeneratedColumn, ManyToOne, JoinColumn, CreateDateColumn, UpdateDateColumn, OneToMany } from 'typeorm';
import { Category } from './category.entity';
import { MenuItemOption } from './menuItemOption.entity';
import { Restaurant } from '../../restaurants/entities/restaurant.entity';

@Entity('menu_items')
export class MenuItem {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column()
  description: string;

  @Column('decimal', { precision: 10, scale: 2 })
  price: number;

  @Column({ nullable: true })
  image: string;

  @Column({ name: 'category_id' })
  category_id: string;

  @ManyToOne(() => Category)
  @JoinColumn({ name: 'category_id' })
  category: Category;

  @Column({ name: 'restaurant_id', nullable: true })
  restaurant_id: string;

  @ManyToOne(() => Restaurant, restaurant => restaurant.menu_items)
  @JoinColumn({ name: 'restaurant_id' })
  restaurant: Restaurant;

  @Column({ name: 'is_available', default: true })
  is_available: boolean;

  @Column({ name: 'is_new', default: false })
  is_new: boolean;

  @Column({ name: 'ingredients', nullable: true })
  ingredients: string;

  @Column({ name: 'rating', default: 0 })
  rating: number;

  @Column({ name: 'total_reviews', default: 0 })
  total_reviews: number;

  @Column({ name: 'discounted_price', nullable: true, type: 'decimal', precision: 10, scale: 2 })
  discounted_price: number;

  @Column({ name: 'original_price', nullable: true, type: 'decimal', precision: 10, scale: 2 })
  original_price: number;

  @Column({ name: 'is_promoted', default: false })
  is_promoted: boolean;

  @Column({ name: 'promotion_price', nullable: true, type: 'decimal', precision: 10, scale: 2 })
  promotion_price: number;

  @CreateDateColumn({ name: 'created_at' })
  created_at: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updated_at: Date;

  @OneToMany(() => MenuItemOption, option => option.menu_item)
  options: MenuItemOption[];
}