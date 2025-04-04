import { Entity, Column, ManyToOne, JoinColumn, PrimaryColumn } from 'typeorm';
import { OrderItem } from './orderItem.entity';

@Entity('order_item_supplements')
export class OrderItemSupplement {
  @PrimaryColumn({ name: 'order_item_id' })
  orderItemId: string;

  @PrimaryColumn({ name: 'supplement_id' })
  supplementId: string;

  @ManyToOne(() => OrderItem, (orderItem) => orderItem.supplements, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_item_id' })
  orderItem: OrderItem;
}