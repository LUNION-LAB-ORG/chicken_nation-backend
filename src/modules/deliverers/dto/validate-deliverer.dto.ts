import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';

/**
 * Validation d'un livreur (09/11, « valider avec le restaurant ») : le
 * restaurant choisi dans la même fenêtre. Absent : celui qu'il a déjà, comme
 * avant. Dans les deux cas, il rejoint les plannings non archivés du
 * restaurant à partir du prochain créneau.
 */
export class ValidateDelivererDto {
  @ApiPropertyOptional({ description: 'UUID du restaurant de rattachement, choisi à la validation' })
  @IsOptional()
  @IsUUID()
  restaurant_id?: string;
}
