import { IsOptional, IsUUID } from 'class-validator';

/**
 * Le livreur appelle le service client (POST /calls/deliverer). Les deux
 * champs sont facultatifs : sans eux, ou s'ils ne désignent pas une de ses
 * courses, le serveur prend sa course en cours.
 */
export class StartDelivererCallDto {
  /** La course dont il veut parler. */
  @IsOptional()
  @IsUUID()
  course_id?: string;

  /** La commande dont il veut parler (sa course en est déduite). */
  @IsOptional()
  @IsUUID()
  order_id?: string;
}
