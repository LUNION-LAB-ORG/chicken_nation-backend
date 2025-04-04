import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn, OneToMany } from 'typeorm';
import { Order } from './order.entity';
import { MenuItem } from '../../menu/entities/menuItem.entity';
import { OrderItemSupplement } from './orderItemSupplement.entity';

@Entity('order_items')
export class OrderItem {
  @PrimaryGeneratedColumn()
  id: string;

  @Column({ name: 'order_id' })
  orderId: string;

  @ManyToOne(() => Order, (order) => order.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order: Order;

  @Column({ name: 'product_id' })
  productId: string;

  @ManyToOne(() => MenuItem)
  @JoinColumn({ name: 'product_id' })
  product: MenuItem;

  @Column()
  quantity: number;

  @OneToMany(() => OrderItemSupplement, (supplement) => supplement.orderItem, {
    cascade: true,
  })
  supplements: OrderItemSupplement[];
}