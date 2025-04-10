import { Entity, Column, ManyToOne } from 'typeorm';
import { Order } from 'src/orders/entities/order.entity';
import { Dish } from 'src/menu/entities/dish.entity';
import { SharedProp } from 'src/common/helpers/sharedProp.helper';

@Entity('order_items')
export class OrderItem extends SharedProp {

  @Column({ default: 1 })
  quantity: number;

  @Column({ type: 'float' })
  amount: number;

  @Column()
  orderId: string;

  @ManyToOne(() => Order, order => order.orderItems, { onDelete: 'CASCADE' })
  order: Order;

  @Column()
  dishId: string;

  @ManyToOne(() => Dish, dish => dish.orderItems)
  dish: Dish;

  @Column({ type: 'json', nullable: true })
  supplements: any;
}