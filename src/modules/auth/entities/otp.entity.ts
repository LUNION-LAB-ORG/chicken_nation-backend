import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

@Entity()
export class Otp {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 20 })
  phone_number: string;

  @Column({ type: 'varchar', length: 6 })
  code: string;

  @CreateDateColumn()
  created_at: Date;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP + interval \'15 minutes\'' })
  expires_at: Date;

  @Column({ type: 'boolean', default: false })
  is_used: boolean;
}