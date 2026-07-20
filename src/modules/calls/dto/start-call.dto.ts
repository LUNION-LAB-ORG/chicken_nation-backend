import { IsIn, IsOptional, IsUUID } from 'class-validator';

export class StartCallDto {
  /**
   * Nature de la cible. Pour un appelant non-admin, le serveur la déduit de la
   * config de routage. L'admin peut cibler explicitement :
   * - 'RESTAURANT' + restaurantId  → sonnerie de groupe du restaurant
   * - 'CALL_CENTER'                → sonnerie de groupe du call center
   * - 'USER' + targetUserId        → appel individuel (P2P)
   */
  @IsOptional()
  @IsIn(['RESTAURANT', 'CALL_CENTER', 'USER'])
  targetKind?: 'RESTAURANT' | 'CALL_CENTER' | 'USER';

  /** Requis quand la cible est un restaurant précis. */
  @IsOptional()
  @IsUUID()
  restaurantId?: string;

  /** Requis pour un appel individuel (P2P) — cible un utilisateur précis. */
  @IsOptional()
  @IsUUID()
  targetUserId?: string;
}
