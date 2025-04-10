import { Entity, Column, OneToMany, OneToOne } from 'typeorm';
import { Address } from 'src/customer/entities/address.entity';
import { Favorite } from 'src/customer/entities/favorite.entity';
import { OtpToken } from 'src/auth/entities/otp-token.entity';
import { SharedProp } from 'src/common/helpers/sharedProp.helper';
import { NotificationPreference } from 'src/notifications/entities/notification-preference.entity';

@Entity('customers')
export class Customer extends SharedProp {
  @Column({ unique: true })
  phone: string;

  @Column({ type: "varchar", length: 255 })
  first_name: string;

  @Column({ type: "varchar", length: 255 })
  last_name: string;

  @Column({ type: "varchar", length: 255, unique: true })
  username: string;

  @Column({ nullable: true })
  image: string;

  @OneToMany(() => Address, address => address.customer)
  addresses: Address[];

  @OneToMany(() => Favorite, favorite => favorite.customer)
  favorites: Favorite[];

  @OneToMany(() => OtpToken, otpToken => otpToken.customer)
  otpTokens: OtpToken[];

  @OneToOne(() => NotificationPreference, (notificationPreference) => notificationPreference.customer, { onDelete: "CASCADE" })
  notificationPreference: NotificationPreference;
}