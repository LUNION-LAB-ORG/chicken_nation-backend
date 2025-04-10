import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('counter_otp')
export class CounterOtp {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    counter: number;
}