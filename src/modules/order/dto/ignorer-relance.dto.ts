import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { RAISONS_IGNORER, RaisonIgnorer } from '../relance/relance.rules';

/**
 * Corps de `POST /orders/relances/:orderId/ignorer`. « Autre » exige un texte,
 * vérifié par le service après nettoyage des espaces (« Précisez la raison. »).
 */
export class IgnorerRelanceDto {
  @ApiProperty({ enum: RAISONS_IGNORER })
  @IsIn(RAISONS_IGNORER, { message: 'Choisissez une raison.' })
  raison_code!: RaisonIgnorer;

  @ApiPropertyOptional({ maxLength: 160 })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString({ message: 'Précisez la raison en texte.' })
  @MaxLength(160, { message: 'Précisez la raison en 160 caractères au plus.' })
  raison_texte?: string;
}
