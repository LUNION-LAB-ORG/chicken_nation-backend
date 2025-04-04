import { Entity, Column, PrimaryGeneratedColumn, ManyToOne, JoinColumn, CreateDateColumn, UpdateDateColumn } from 'typeorm';
import { MenuItem } from './menuItem.entity';

@Entity('menu_item_options')
export class MenuItemOption {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  name: string;

  @Column({ nullable: true })
  description: string;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0, name: 'additional_price' })
  additional_price: number;

  @Column({ name: 'menu_item_id' })
  menu_item_id: string;

  @Column({ name: 'menuItemId', type: 'int' })
  menuItemId: number;

  @ManyToOne(() => MenuItem)
  @JoinColumn({ name: 'menu_item_id' }) 
  menu_item: MenuItem;

  @Column({ default: true, name: 'is_available' })
  is_available: boolean;

  @CreateDateColumn({ name: 'created_at' })
  created_at: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updated_at: Date;
}