// SpecialOfferDish.entity.ts
import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, JoinColumn } from 'typeorm';
import { Dish } from 'src/menu/entities/dish.entity';
import { SpecialOffer } from 'src/special-offer/entities/special-offer.entity';

@Entity()
export class SpecialOfferDish {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ type: 'uuid' })
    dishId: string;

    @Column({ type: 'uuid' })
    specialOfferId: string;

    @ManyToOne(() => Dish, dish => dish.specialOfferDishes, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'dishId' })
    dish: Dish;

    @ManyToOne(() => SpecialOffer, specialOffer => specialOffer.dishes, { onDelete: 'CASCADE' })
    @JoinColumn({ name: 'specialOfferId' })
    specialOffer: SpecialOffer;
}