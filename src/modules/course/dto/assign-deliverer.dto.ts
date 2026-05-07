import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsUUID } from 'class-validator';

/**
 * Force l'affectation d'un livreur précis à une course — endpoint admin uniquement.
 * Sert à outrepasser l'algo automatique en cas de besoin opérationnel.
 */
export class AssignDelivererDto {
  @ApiProperty({ description: 'UUID du livreur à affecter' })
  @IsNotEmpty()
  @IsUUID()
  deliverer_id: string;
}
