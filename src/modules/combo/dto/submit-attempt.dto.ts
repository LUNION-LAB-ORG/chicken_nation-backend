import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

/** Un choix : l'item sélectionné pour un slot (le slot_id sert à l'UI ; la
 *  comparaison serveur se fait sur l'ENSEMBLE des item_id, ordre indifférent). */
export class ComboSelectionDto {
  @ApiProperty({ description: 'Id du slot (ligne à deviner)', required: false })
  @IsOptional()
  @IsString()
  slot_id?: string;

  @ApiProperty({ description: "Id de l'item choisi (plat ou supplément du menu)" })
  @IsString()
  item_id: string;
}

/**
 * Tentative de résolution du COMBO MYSTÈRE (client) : un item choisi par slot.
 * La solution n'est JAMAIS renvoyée : on retourne seulement correct + compteur
 * d'essais. La comparaison est faite sur l'ENSEMBLE des item_id (ordre/slot
 * indifférent), les ids étant uniques.
 */
export class SubmitAttemptDto {
  @ApiProperty({
    description: 'Sélections du joueur (un item par slot)',
    type: [ComboSelectionDto],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ComboSelectionDto)
  selections: ComboSelectionDto[];
}
