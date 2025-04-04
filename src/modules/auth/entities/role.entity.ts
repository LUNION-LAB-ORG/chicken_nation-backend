import { Entity, PrimaryGeneratedColumn, Column, ManyToMany, JoinTable } from 'typeorm';
import { User } from './user.entity';

@Entity('role')
export class Role {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 50, unique: true })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string;

  @ManyToMany(() => User, user => user.roles)
  @JoinTable({
    name: 'role_users_user',
    joinColumn: {
      name: 'roleId',
      referencedColumnName: 'id'
    },
    inverseJoinColumn: {
      name: 'userId',
      referencedColumnName: 'id'
    }
  })
  users: User[];
}