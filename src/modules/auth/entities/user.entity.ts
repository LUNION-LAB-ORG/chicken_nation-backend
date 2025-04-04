import { Entity, PrimaryGeneratedColumn, Column, ManyToMany, OneToMany, OneToOne } from 'typeorm';
import { Role } from './role.entity';
import { UserAddress } from '../../user-profile/entities/user-address.entity';
import { NotificationSetting } from '../../user-profile/entities/notification-setting.entity';
import { UserFavorite } from '../../user-profile/entities/user-favorite.entity';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255 })
  first_name: string;

  @Column({ type: 'varchar', length: 255 })
  last_name: string;

  @Column({ type: 'varchar', length: 255, unique: true })
  username: string;

  @Column({ type: 'varchar', length: 255, unique: true })
  email: string;

  @Column({ type: 'varchar', length: 255 })
  password: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  phone_number: string;

  @Column({ type: 'boolean', default: false })
  is_admin: boolean;
  
  @Column({ type: 'varchar', nullable: true })
  profile_picture: string;

  @ManyToMany(() => Role, role => role.users)
  roles: Role[];
  
  @OneToMany(() => UserAddress, address => address.user)
  addresses: UserAddress[];
  
  @OneToOne(() => NotificationSetting, settings => settings.user)
  notificationSettings: NotificationSetting;
  
  @OneToMany(() => UserFavorite, favorite => favorite.user)
  favorites: UserFavorite[];
}