import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString } from 'class-validator';
import { EMOJIS_REACTION } from 'src/common/constantes/emojis-reaction';

/**
 * Emoji posé en réaction.
 *
 * Validé ici ET dans le service. Le doublon est volontaire : le service est
 * appelé par plusieurs contrôleurs, et c'est lui qui écrit en base. La règle
 * doit tenir même si un appelant oublie son DTO.
 */
export class BasculerReactionDto {
  @ApiProperty({ description: 'Emoji de réaction', enum: EMOJIS_REACTION })
  @IsString()
  @IsIn(EMOJIS_REACTION as unknown as string[])
  emoji: string;
}
