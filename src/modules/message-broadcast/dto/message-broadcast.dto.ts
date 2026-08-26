import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsDateString,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Modes de ciblage.
 *
 * ⚠️ Le mode « filtres libres » du module push n'est VOLONTAIREMENT pas repris.
 * Son moteur déclare un opérateur qu'il ne lit jamais et ne gère que quatre
 * champs sur quinze : « moins de deux commandes » y donne le même résultat que
 * « plus de deux commandes ». L'exposer tromperait l'utilisateur. Les critères
 * libres passent par un segment enregistré, qui utilise le vrai moteur.
 */
export const CIBLAGES = ['all', 'segment', 'ids'] as const;
export type Ciblage = (typeof CIBLAGES)[number];

export class CreerDiffusionDto {
  @ApiProperty({ description: 'Nom interne, vu du backoffice seulement' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name: string;

  @ApiProperty({ description: 'Message envoyé au client. `{{first_name}}` est remplacé.' })
  @IsString()
  @MinLength(2)
  @MaxLength(2000)
  body: string;

  @ApiProperty({ enum: CIBLAGES })
  @IsIn(CIBLAGES as unknown as string[])
  target_type: Ciblage;

  @ApiProperty({
    description:
      "Selon le ciblage : {} pour « all », { segment: 'custom_<uuid>' | '<systeme>' }, ou { ids: ['<uuid>'] }",
  })
  @IsObject()
  target_config: Record<string, any>;

  @ApiPropertyOptional({ description: 'Départ différé. Absent = envoi immédiat au clic sur Envoyer.' })
  @IsOptional()
  @IsDateString()
  scheduled_at?: string;
}

export class ApercuAudienceDto {
  @ApiProperty({ enum: CIBLAGES })
  @IsIn(CIBLAGES as unknown as string[])
  target_type: Ciblage;

  @ApiProperty()
  @IsObject()
  target_config: Record<string, any>;
}

export class ListerDiffusionsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  ids?: string[];
}
