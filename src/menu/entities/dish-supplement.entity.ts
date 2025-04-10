import { Entity, PrimaryGeneratedColumn, Column, ManyToOne } from 'typeorm';
import { Dish } from 'src/menu/entities/dish.entity';
import { Supplement } from 'src/menu/entities/supplement.entity';

@Entity('dish_supplements')
export class DishSupplement {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  dishId: string;

  @Column()
  supplementId: string;

  @ManyToOne(() => Dish, dish => dish.supplements, { onDelete: 'CASCADE' })
  dish: Dish;

  @ManyToOne(() => Supplement, supplement => supplement.dishSupplements, { onDelete: 'CASCADE' })
  supplement: Supplement;
}