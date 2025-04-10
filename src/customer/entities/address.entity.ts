import { Entity, Column, ManyToOne, OneToMany } from 'typeorm';
import { Customer } from 'src/customer/entities/customer.entity';
import { Order } from 'src/orders/entities/order.entity';
import { SharedProp } from 'src/common/helpers/sharedProp.helper';

@Entity('addresses')
export class Address extends SharedProp {

    @Column()
    title: string;

    @Column()
    address: string;

    @Column({ nullable: true })
    street: string;

    @Column({ nullable: true })
    city: string;

    @Column({ type: 'float' })
    longitude: number;

    @Column({ type: 'float' })
    latitude: number;

    @OneToMany(() => Order, order => order.address)
    orders: Order[];

    @ManyToOne(() => Customer, customer => customer.addresses, { onDelete: 'CASCADE', nullable: true })
    customer: Customer;

    @Column({ nullable: true })
    customerId: string;
}