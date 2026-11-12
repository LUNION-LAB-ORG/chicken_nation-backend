import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, MaxLength } from 'class-validator';

/**
 * Référence de la transaction que l'écran a vérifiée : si le paiement a changé
 * entre la vérification et la confirmation, le serveur refuse (409).
 */
export class RembourserPaiementDto {
  @ApiProperty({ description: 'Référence KKiaPay affichée à la vérification' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString({ message: 'Référence de transaction manquante.' })
  @MaxLength(120)
  reference: string;
}
