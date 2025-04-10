import { Entity, Column, ManyToOne } from 'typeorm';
import { Order } from 'src/orders/entities/order.entity';
import { MobileMoneyType, PaiementStatus, PaiementType } from '../enums/paiement.enum';
import { SharedProp } from 'src/common/helpers/sharedProp.helper';

@Entity('paiements')
export class Paiement extends SharedProp {

    @Column({ type: 'float' })
    amount: number;

    @Column()
    orderId: string;

    @ManyToOne(() => Order, order => order.payments, { onDelete: 'CASCADE' })
    order: Order;

    @Column({ type: 'enum', enum: PaiementType })
    mode: PaiementType;

    @Column({ type: 'enum', enum: MobileMoneyType, nullable: true })
    mobileMoneyType: MobileMoneyType;

    @Column({ type: 'enum', enum: PaiementStatus })
    status: PaiementStatus;

    @Column()
    reference: string;
}