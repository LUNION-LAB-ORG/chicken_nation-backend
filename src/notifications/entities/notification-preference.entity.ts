import { Customer } from "src/customer/entities/customer.entity";
import {
  Entity,
  Column,
  PrimaryColumn,
  OneToOne,
  JoinColumn,
} from "typeorm";

@Entity("notification_settings")
export class NotificationPreference {
  @PrimaryColumn({ name: "customer_id", type: "uuid" })
  customerID: string;

  @OneToOne(() => Customer, (customer) => customer.notificationPreference, { onDelete: "CASCADE" })
  @JoinColumn({ name: "customer_id" })
  customer: Customer;

  @Column({ type: "jsonb", name: "order_updates" })
  orderUpdates: Record<string, any>;

  @Column({ type: "jsonb", name: "promotions" })
  promotions: Record<string, any>;

  @Column({ type: "jsonb", name: "newsletter" })
  newsletter: Record<string, any>;

  @Column({ type: "jsonb", name: "push_notifications" })
  pushNotifications: Record<string, any>;
}
