import {
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { EntityStatus } from '../../_database/enums/entity-status.enum';

export class SharedProp {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({
    type: 'enum',
    enum: EntityStatus,
    default: EntityStatus.NEW,
    name: 'entity_status',
  })
  entityStatus: string;

  @CreateDateColumn({
    default: () => 'CURRENT_TIMESTAMP',
    type: 'timestamp',
    name: 'created_at',
  })
  createdAt: Date;

  @UpdateDateColumn({
    default: () => 'CURRENT_TIMESTAMP',
    type: 'timestamp',
    name: 'updated_at',
  })
  updatedAt: Date;
}
