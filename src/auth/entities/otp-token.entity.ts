import { Entity, PrimaryGeneratedColumn, Column, ManyToOne } from 'typeorm';
import { Customer } from 'src/customer/entities/customer.entity';

@Entity('otp_tokens')
export class OtpToken {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column({ length: 255 })
    code: string;

    @Column({ nullable: true })
    telephone: string;

    @Column({ nullable: true })
    counter: number;

    @Column()
    expire: Date;

    @Column({ nullable: true })
    customerId: string;

    @ManyToOne(() => Customer, customer => customer.otpTokens, { onDelete: 'CASCADE', nullable: true })
    customer: Customer;
}