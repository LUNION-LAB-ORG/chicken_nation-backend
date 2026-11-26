import { IsIn, IsOptional, IsUUID } from 'class-validator';

export class StartCallDto {
  /**
   * Nature de la cible. Pour un appelant non-admin, le serveur la déduit de la
   * config de routage. L'admin peut cibler explicitement :
   * - 'RESTAURANT' + restaurantId  → sonnerie de groupe du restaurant
   * - 'CALL_CENTER'                → sonnerie de groupe du call center
   * - 'USER' + targetUserId        → appel individuel (P2P)
   * Le service client (CALL_CENTER) et l'admin appellent un livreur :
   * - 'DELIVERER' + deliverer_id   → l'appli du livreur sonne (24/10)
   * et un client dans l'appli Chicken Nation :
   * - 'CUSTOMER' + customer_id     → l'appli du client sonne (26/11)
   */
  @IsOptional()
  @IsIn(['RESTAURANT', 'CALL_CENTER', 'USER', 'DELIVERER', 'CUSTOMER'])
  targetKind?: 'RESTAURANT' | 'CALL_CENTER' | 'USER' | 'DELIVERER' | 'CUSTOMER';

  /** Requis quand la cible est un restaurant précis. */
  @IsOptional()
  @IsUUID()
  restaurantId?: string;

  /** Requis pour un appel individuel (P2P) — cible un utilisateur précis. */
  @IsOptional()
  @IsUUID()
  targetUserId?: string;

  /** Requis avec `targetKind: 'DELIVERER'` : le livreur dont l'appli sonne. */
  @IsOptional()
  @IsUUID()
  deliverer_id?: string;

  /** Requis avec `targetKind: 'CUSTOMER'` : le client dont l'appli sonne. */
  @IsOptional()
  @IsUUID()
  customer_id?: string;

  /** Avec `targetKind: 'CUSTOMER'` : la commande dont l'agent veut parler. */
  @IsOptional()
  @IsUUID()
  order_id?: string;
}
