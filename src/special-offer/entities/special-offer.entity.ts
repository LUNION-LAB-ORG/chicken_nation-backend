import { Entity, PrimaryGeneratedColumn, Column, OneToMany } from 'typeorm';
import { SpecialOfferDish } from 'src/special-offer/entities/special-offer-dish.entity';

@Entity('special_offers')
export class SpecialOffer {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    name: string;

    @Column({ nullable: true })
    description: string;

    @Column()
    image: string;

    @Column({ type: 'float' })
    tax: number;

    @Column()
    startDate: Date;

    @Column()
    endDate: Date;

    @OneToMany(() => SpecialOfferDish, specialOfferDish => specialOfferDish.specialOffer)
    dishes: SpecialOfferDish[];
}