import {
  Entity,
  Column,
  Index,
} from "typeorm";
import { NotificationType } from "src/notifications/enums/notification.enum";
import { SharedProp } from "src/_database/helpers/sharedProp.helper";

@Entity("notifications")
export class Notification extends SharedProp {
  @Column({ name: "user_id" })
  @Index()
  userId: string;

  @Column()
  icon: string;

  @Column({ name: "icon_bg_color" })
  iconBgColor: string;

  @Column()
  title: string;

  @Column({ type: "date" })
  date: Date;

  @Column()
  time: string;

  @Column()
  message: string;

  @Column({
    type: "enum",
    enum: NotificationType,
  })
  @Index()
  type: NotificationType;

  @Column({ name: "is_read", default: false })
  isRead: boolean;

  @Column({ name: "show_chevron", default: true, nullable: true })
  showChevron: boolean;

  @Column({ name: "notif_banner" })
  notifBanner: string;

  @Column({ name: "notif_title" })
  notifTitle: string;

  @Column({ type: "jsonb", nullable: true })
  data: Record<string, any>;
}
