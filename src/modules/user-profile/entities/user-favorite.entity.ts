import { Entity, Column, ManyToOne, JoinColumn, PrimaryGeneratedColumn } from 'typeorm';
import { User } from '../../auth/entities/user.entity';

@Entity('user_favorites')
export class UserFavorite {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ nullable: true, name: 'restaurant_id', type: 'varchar' })
  restaurantId: string;

  @Column({ nullable: true, name: 'product_id', type: 'varchar' })
  productId: string;

  @Column({ name: 'user_id' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  // Note: Les relations avec Restaurant et MenuItem seraient ajoutées ici
  // mais elles dépendent des modules correspondants
}
