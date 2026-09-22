import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

/** Collègues à faire entrer dans un groupe existant. */
export class AjouterParticipantsDto {
  @ApiProperty({ description: 'Identifiants des personnes à ajouter', type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  // Même plafond qu'à la création : un groupe qui dépasse la trentaine n'est
  // plus une conversation, c'est une liste de diffusion.
  @ArrayMaxSize(30)
  @IsUUID(undefined, { each: true })
  user_ids: string[];
}

/** Nouveau nom d'un groupe. */
export class RenommerGroupeDto {
  @ApiProperty({ description: 'Nouveau nom du groupe' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  subject: string;
}
