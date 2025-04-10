import { SharedProp } from 'src/_database/helpers/sharedProp.helper';
import { DishRestaurant } from 'src/menu/entities/dish-restaurant.entity';
import { User } from 'src/users/entities/user.entity';
import {
    Entity,
    Column,
    OneToMany,
} from 'typeorm';

@Entity('restaurants')
export class Restaurant extends SharedProp {

    @Column()
    name: string;

    @Column({ default: () => 'uuid_generate_v4()' })
    manager: string;

    @Column({ nullable: true })
    description: string;

    @Column({ nullable: true })
    image: string;

    @Column({ nullable: true })
    address: string;

    @Column({ type: 'float', nullable: true })
    latitude: number;

    @Column({ type: 'float', nullable: true })
    longitude: number;

    @Column({ nullable: true })
    phone: string;

    @Column({ nullable: true })
    email: string;

    @Column({ type: 'json', nullable: true })
    schedule: any;

    @OneToMany(() => User, (user) => user.restaurant)
    users: User[];

    @OneToMany(() => DishRestaurant, dishRestaurant => dishRestaurant.restaurant)
    dishRestaurants: DishRestaurant[];
}
