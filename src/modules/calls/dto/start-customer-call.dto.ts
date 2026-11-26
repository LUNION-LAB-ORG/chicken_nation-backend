import { IsIn, IsOptional, IsUUID } from 'class-validator';

/**
 * Le client appelle depuis l'appli Chicken Nation (POST /calls/customer,
 * 26/11) : le service client (par défaut) ou le livreur de sa commande.
 */
export class StartCustomerCallDto {
  /** `SERVICE_CLIENT` (par défaut) ou `LIVREUR` (avec `order_id`). */
  @IsOptional()
  @IsIn(['SERVICE_CLIENT', 'LIVREUR'])
  cible?: 'SERVICE_CLIENT' | 'LIVREUR';

  /**
   * La commande dont il veut parler. Requise pour appeler le livreur ; pour
   * le service client, sans elle le serveur prend sa commande récente.
   */
  @IsOptional()
  @IsUUID()
  order_id?: string;
}
