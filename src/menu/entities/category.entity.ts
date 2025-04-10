import { Entity, Column, OneToMany } from 'typeorm';
import { SharedProp } from 'src/_database/helpers/sharedProp.helper';
import { Dish } from 'src/menu/entities/dish.entity';

@Entity('categories')
export class Category extends SharedProp {

    @Column()
    name: string;

    @Column({ nullable: true })
    description: string;

    @Column({ nullable: true })
    image: string;

    @OneToMany(() => Dish, dish => dish.category)
    dishes: Dish[];
}