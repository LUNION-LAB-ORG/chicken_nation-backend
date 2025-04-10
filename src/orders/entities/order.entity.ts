import { Entity, Column, ManyToOne, OneToMany, Index } from 'typeorm';
import { Address } from 'src/customer/entities/address.entity';
import { OrderItem } from 'src/orders/entities/order-item.entity';
import { Paiement } from 'src/paiements/entities/paiement.entity';
import { OrderType } from 'src/orders/enums/order-type.enum';
import { SharedProp } from 'src/_database/helpers/sharedProp.helper';

@Entity('orders')
@Index(['addressId'])
export class Order extends SharedProp {

    @Column({ type: 'enum', enum: OrderType })
    type: OrderType;

    @Column()
    addressId: string;

    @ManyToOne(() => Address, address => address.orders, { onDelete: 'CASCADE' })
    address: Address;

    @OneToMany(() => OrderItem, orderItem => orderItem.order)
    orderItems: OrderItem[];

    @Column({ nullable: true })
    codePromo: string;

    @Column({ type: 'float' })
    deliveryFee: number;

    @Column({ type: 'float' })
    tax: number;

    @Column({ type: 'float' })
    amount: number;

    @Column({ type: 'float' })
    netAmount: number;

    @Column({ type: 'date', nullable: true })
    date: Date;

    @Column({ type: 'time', nullable: true })
    time: Date;

    @Column({ nullable: true })
    fullname: string;

    @Column({ nullable: true })
    phone: string;

    @Column({ nullable: true })
    email: string;

    @Column({ nullable: true })
    note: string;

    @OneToMany(() => Paiement, paiement => paiement.order)
    payments: Paiement[];
}