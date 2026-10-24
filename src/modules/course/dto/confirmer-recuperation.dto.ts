import { ApiProperty } from '@nestjs/swagger';
import { ArrayMinSize, IsArray, IsUUID } from 'class-validator';

/**
 * Récupération confirmée depuis le groupe de la course
 * (`POST /courses/operations/:id/recuperation`) : les commandes que la
 * caissière remet au livreur, telles que sa fenêtre les montre. Une commande
 * qui n'est plus dans la course : 409, la fenêtre est relue.
 */
export class ConfirmerRecuperationDto {
  @ApiProperty({
    description: 'Commandes remises au livreur (au moins une)',
    type: [String],
    example: ['7b0c2f1e-3a4d-4e5f-8a9b-0c1d2e3f4a5b'],
  })
  @IsArray({ message: 'Choisissez au moins une commande.' })
  @ArrayMinSize(1, { message: 'Choisissez au moins une commande.' })
  @IsUUID(undefined, { each: true, message: 'Commande inconnue.' })
  order_ids: string[];
}
