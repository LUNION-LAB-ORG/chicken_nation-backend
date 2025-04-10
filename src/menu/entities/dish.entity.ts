import { Entity, Column, ManyToOne, OneToMany, Index } from 'typeorm';
import { Category } from 'src/menu/entities/category.entity';
import { SharedProp } from 'src/_database/helpers/sharedProp.helper';
import { DishSupplement } from 'src/menu/entities/dish-supplement.entity';
import { DishRestaurant } from 'src/menu/entities/dish-restaurant.entity';
import { Favorite } from 'src/customer/entities/favorite.entity';
import { OrderItem } from 'src/orders/entities/order-item.entity';
import { SpecialOfferDish } from 'src/special-offer/entities/special-offer-dish.entity';

@Entity('dishes')
@Index(['categoryId', 'available'])
export class Dish extends SharedProp {

    @Column()
    name: string;

    @Column({ nullable: true })
    description: string;

    @Column({ type: 'float' })
    price: number;

    @Column({ nullable: true })
    image: string;

    @Column({ default: true })
    available: boolean;

    @Column({ default: false })
    isNew: boolean;

    @Column()
    categoryId: string;

    @ManyToOne(() => Category, category => category.dishes, { onDelete: 'CASCADE' })
    category: Category;

    @OneToMany(() => DishSupplement, dishSupplement => dishSupplement.dish)
    supplements: DishSupplement[];

    @OneToMany(() => Favorite, favorite => favorite.dish)
    favorites: Favorite[];

    @OneToMany(() => DishRestaurant, dishRestaurant => dishRestaurant.dish)
    dishRestaurants: DishRestaurant[];

    @OneToMany(() => OrderItem, orderItem => orderItem.dish)
    orderItems: OrderItem[];

    @OneToMany(() => SpecialOfferDish, specialOfferDish => specialOfferDish.dish)
    specialOfferDishes: SpecialOfferDish[];
}