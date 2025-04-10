import { Entity, PrimaryGeneratedColumn, Column, ManyToOne } from 'typeorm';
import { Dish } from 'src/menu/entities/dish.entity';
import { Restaurant } from 'src/restaurant/entities/restaurant.entity';


@Entity('dish_restaurants')
export class DishRestaurant {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    dishId: string;

    @Column()
    restaurantId: string;

    @ManyToOne(() => Dish, dish => dish.dishRestaurants, { onDelete: 'CASCADE' })
    dish: Dish;

    @ManyToOne(() => Restaurant, restaurant => restaurant.dishRestaurants, { onDelete: 'CASCADE' })
    restaurant: Restaurant
}