import { Entity, PrimaryGeneratedColumn, Column, OneToMany } from 'typeorm';
import { DishSupplement } from 'src/menu/entities/dish-supplement.entity';

export enum CategorySupplement {
    FOOD = 'FOOD',
    DRINK = 'DRINK',
    ACCESSORY = 'ACCESSORY'
}

@Entity('supplements')
export class Supplement {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    name: string;

    @Column({ type: 'float' })
    price: number;

    @Column({ nullable: true })
    image: string;

    @Column({ default: true })
    available: boolean;

    @Column({ type: 'enum', enum: CategorySupplement })
    category: CategorySupplement;

    @OneToMany(() => DishSupplement, dishSupplement => dishSupplement.supplement)
    dishSupplements: DishSupplement[];
}