import { Entity, Column, ManyToOne, Index } from 'typeorm';
import { UserType, UserRole } from 'src/users/enums/user.enum';
import { Restaurant } from 'src/restaurant/entities/restaurant.entity';
import { SharedProp } from 'src/common/helpers/sharedProp.helper';


@Entity('users')
@Index(['email', 'type'])
export class User extends SharedProp {
    @Column()
    fullname: string;

    @Column({ unique: true })
    email: string;

    @Column({ nullable: true })
    phone: string;

    @Column()
    password: string;

    @Column({ nullable: true })
    image: string;

    @Column({ nullable: true })
    address: string;

    @Column({ type: 'enum', enum: UserType })
    type: UserType;

    @Column({ type: 'enum', enum: UserRole })
    role: UserRole;

    @ManyToOne(() => Restaurant, restaurant => restaurant.users, { onDelete: 'CASCADE', nullable: true })
    restaurant: Restaurant;

    @Column({ nullable: true })
    restaurantId: string;
}