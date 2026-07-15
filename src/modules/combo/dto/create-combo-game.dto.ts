import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { ComboItemDto } from './combo-item.dto';

/**
 * Création d'un COMBO MYSTÈRE (back office).
 * `prize` est validé/enrichi côté service : { reward_type: 'GIFT', payload: { dish_id } }
 * → le service vérifie le plat et snapshotte nom/prix/image (comme les campagnes Reward).
 * `solution` est vérifiée contre le menu réel (chaque item doit exister).
 */
export class CreateComboGameDto {
  @ApiProperty({ description: 'Titre du jeu', example: 'Le Combo Mystère de la semaine' })
  @IsString()
  @MaxLength(160)
  title: string;

  @ApiProperty({ description: 'Description / règle du jeu', required: false })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({
    description: 'Indices révélés progressivement',
    type: [String],
    example: ['Un plat signature', 'Un accompagnement croustillant', 'La sauce maison'],
  })
  @IsArray()
  @IsString({ each: true })
  clues: string[];

  @ApiProperty({
    description: 'Combinaison-solution (ensemble d\'items du menu, ordre indifférent)',
    type: [ComboItemDto],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ComboItemDto)
  solution: ComboItemDto[];

  @ApiProperty({ description: 'Ouverture du jeu (ISO 8601)' })
  @IsDateString()
  starts_at: string;

  @ApiProperty({ description: 'Clôture du jeu (ISO 8601)' })
  @IsDateString()
  ends_at: string;

  @ApiProperty({ description: 'Essais max par compte et par partie (RG-10)', default: 3, required: false })
  @IsOptional()
  @IsInt()
  @Min(1)
  max_attempts?: number;

  @ApiProperty({ description: 'Nombre de gagnants tirés au sort', default: 1, required: false })
  @IsOptional()
  @IsInt()
  @Min(1)
  winners_count?: number;

  @ApiProperty({
    description: 'Lot : { reward_type: \'GIFT\', payload: { dish_id } } (snapshot serveur)',
    type: 'object',
    additionalProperties: true,
  })
  @IsObject()
  prize: Record<string, any>;
}
