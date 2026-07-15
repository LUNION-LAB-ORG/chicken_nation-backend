import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMinSize, IsArray, ValidateNested } from 'class-validator';
import { ComboItemDto } from './combo-item.dto';

/**
 * Tentative de résolution du COMBO MYSTÈRE (client).
 * `answer` = la combinaison proposée (items du menu, ordre indifférent). La
 * solution n'est JAMAIS renvoyée : on retourne seulement correct + essais restants.
 */
export class SubmitAttemptDto {
  @ApiProperty({
    description: 'Combinaison proposée (items du menu, ordre indifférent)',
    type: [ComboItemDto],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ComboItemDto)
  answer: ComboItemDto[];
}
