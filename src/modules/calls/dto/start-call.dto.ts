import { IsIn, IsOptional, IsUUID } from 'class-validator';

export class StartCallDto {
  /**
   * Nature de la cible. Optionnel : le serveur la déduit du type de l'appelant
   * via la config de routage. Fourni surtout pour l'explicite côté client.
   */
  @IsOptional()
  @IsIn(['RESTAURANT', 'CALL_CENTER'])
  targetKind?: 'RESTAURANT' | 'CALL_CENTER';

  /** Requis quand la cible est un restaurant précis (appelant BACKOFFICE). */
  @IsOptional()
  @IsUUID()
  restaurantId?: string;
}
