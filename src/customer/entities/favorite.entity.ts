import { Entity, Column, ManyToOne } from 'typeorm';
import { Customer } from './customer.entity';
import { Dish } from 'src/menu/entities/dish.entity';
import { SharedProp } from 'src/_database/helpers/sharedProp.helper';

@Entity('favorites')
export class Favorite extends SharedProp {
    @Column()
    customerId: string;

    @Column()
    dishId: string;

    @ManyToOne(() => Customer, customer => customer.favorites, { onDelete: 'CASCADE' })
    customer: Customer;

    @ManyToOne(() => Dish, dish => dish.favorites, { onDelete: 'CASCADE' })
    dish: Dish;
}