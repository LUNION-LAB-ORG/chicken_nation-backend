import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString } from 'class-validator';

/** Type d'item du menu réel composant une combinaison Combo. */
export type ComboItemType = 'DISH' | 'SUPPLEMENT';

/**
 * Un item d'une combinaison Combo (solution ou réponse) : une référence au MENU
 * RÉEL (plat ou supplément). L'ensemble forme la combinaison (ordre indifférent).
 */
export class ComboItemDto {
  @ApiProperty({ enum: ['DISH', 'SUPPLEMENT'], description: 'Type d\'item du menu' })
  @IsIn(['DISH', 'SUPPLEMENT'])
  type: ComboItemType;

  @ApiProperty({ description: 'Identifiant du plat ou du supplément' })
  @IsString()
  id: string;
}
